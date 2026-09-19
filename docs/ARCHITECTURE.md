# Architecture

Why the pieces are where they are, and what breaks if they move.

## The shape

```
                          ┌──────────────────────────────────────┐
  cron / webhook ────────▶│  Engine                              │
  API ───────────────────▶│  runs → tasks → attempts             │──▶ Store port
  console ───────────────▶│  approvals, events, outbox           │      ├ Postgres
                          └──────────────────────────────────────┘      └ in-memory
                                        ▲          │
                                 leases │          │ outbox
                                        │          ▼
                                    Worker    Dispatcher ──▶ email, tickets, scheduler
                                        │
                                        ▼
                                    Handlers ──▶ Odoo (XML-RPC), Agents (Claude or rules)
```

`packages/core` does no I/O of its own. The engine is a state machine over plain data;
storage, agents and the ERP all arrive through ports. That is what lets the same engine
run behind a Postgres-backed container fleet and inside a serverless console request.

## The five guarantees

Everything else is detail. These are the claims the system actually makes.

### 1. A task is executed by one worker at a time

Leasing is a single statement:

```sql
WITH claimed AS (
  SELECT id FROM tasks
  WHERE status = 'ready' AND (run_after IS NULL OR run_after <= $1)
  ORDER BY run_after NULLS FIRST, created_at
  LIMIT $2
  FOR UPDATE SKIP LOCKED
)
UPDATE tasks t SET status = 'leased', leased_by = $3, ... FROM claimed WHERE t.id = claimed.id
RETURNING t.*
```

`SKIP LOCKED` is the reason ten workers polling the same table do useful work instead of
queueing behind each other. One statement is the reason two of them cannot claim the same
row: splitting the select and the update is the classic way to hand one task to two
workers.

The other half is `assertLease`. A worker may only report on a task it still holds —
without that, a worker whose lease expired, whose task was reclaimed and re-run by
somebody else, can come back minutes later and overwrite the newer result.

### 2. A crashed worker's work is picked up

Leases are short (30s by default) and extended by a heartbeat while a handler runs. Short
leases make recovery fast; heartbeats are what make short leases safe for a task that
legitimately takes four minutes.

An expired lease returns the task to `ready`, **not** `failed`. The work may well have
been done — the worker may have died between doing it and reporting it — so the safe move
is to run it again and rely on handler idempotency. That is why every handler is required
to have it, and why `odoo.log_activity` looks for an existing note before writing one.

### 3. Nothing leaves the building without the approval it needs

An approval gate is a task that suspends itself. The worker calls `requestApproval`, the
task goes to `waiting_approval`, and the run stops.

Which is fine until you ask what happens when somebody says no. A rejected gate is
`skipped` — and so is a gate that was never needed. `dependsOn` cannot tell those apart,
because both leave the task in the same state. So the dependency model has two edges:

| | Means | Used for |
|---|---|---|
| `dependsOn` | must have **settled** (succeeded or skipped) | ordering, where a skipped branch should not hold things up |
| `requires` | must have **succeeded** | anything that must not happen without a real success |

`ar_collections.send_message` uses `requires: ["approve_message"]`, so a rejection or an
expiry skips the send. `lead_followup.send_outreach` uses `requires: ["draft_outreach"]`
and `dependsOn: ["review_outreach"]`, so it sends whether or not review was needed but
never without a draft.

That asymmetry is the difference between a mandatory gate and a conditional one, and it
is declared in the workflow rather than buried in a handler.

### 4. An effect happens exactly once

The transactional outbox. A handler that wants to send an email does not send it — it
returns an outbox message, and the engine writes that message in the **same transaction**
as the task result:

```
BEGIN
  UPDATE tasks SET status = 'succeeded', output = ...
  INSERT INTO events ...
  INSERT INTO outbox (idempotency_key, ...) ON CONFLICT DO NOTHING
COMMIT
```

Without this, a crash between "mark the task done" and "send the email" either loses the
email or sends it twice, and which one you get is luck.

The idempotency key is derived from the run and the task key — `email:${runId}:${taskKey}`
— not from the attempt. A retried task therefore produces the same key, and the unique
index means the second insert is a no-op.

### 5. Every state change has an event explaining it

`events` is append-only, enforced by a trigger rather than by agreement. Run and task rows
are the current state; the event log is how that state came to be.

That distinction matters when finance asks why a customer was chased twice in a week. The
run row says `succeeded`. The event log says which worker leased which task at what time,
that the first attempt failed with `odoo.session_expired`, that Ana approved it at 14:32
with the note "checked with the account manager", and that the outbox delivered one email.

## The state machine, enforced twice

Legal transitions live in `domain/state-machine.ts` and again in
`migrations/0002_state_machine.sql`. The engine checks before every write, so in normal
operation the database trigger never fires.

It exists for the case the engine cannot cover: a rolling deploy, where two versions of
the engine are live at once and the older one tries something the newer schema forbids.
The only component in a position to refuse that is Postgres.

A test asserts the two tables agree, edge for edge. Without it the claim would be true
only until somebody edited one of them.

## Why run status is derived

`deriveRunStatus` computes a run's status from its tasks on every advance. It is not an
independently maintained fact, because a status somebody has to remember to update is how
a run ends up marked `running` for three weeks with every task finished.

`advance()` iterates to a fixed point rather than making one pass. Skipping one task can
settle another's dependency, which can settle a third; a single pass resolves only the
first of those, and the run then waits for an `advance()` that will never come, because
nothing is going to complete and trigger one.

## `failed` vs `quarantined`

Both stop the run. The difference is on the task, and it tells an operator what to do:

- **`failed`** — the failure was permanent. Retrying will produce the same failure.
- **`quarantined`** — the failure was retryable, but the attempts are exhausted. Something
  is wrong that a person should look at, and once they have, requeueing is worth trying.

`requeueTask` accepts either and resets the attempt count.

## Two stores, one contract

`PostgresStore` and `MemoryStore` implement the same interface and pass the same 19-test
contract suite. That is the entire justification for the in-memory store existing: it is
not a convenient fiction, it is the same contract held to the same tests.

The first run of that suite against real Postgres found three invariants the in-memory
store was letting through — a terminal run with no finish time, two tasks sharing a key,
a decided approval with nobody's name on it. All three are now enforced in both, because
a store that is more permissive than the real one makes the contract meaningless.

## Where the agents actually are

Narrow. Each one is given structured facts and asked for a structured judgement, and the
schema of that judgement is fixed by the caller. There is no open-ended tool loop, because
the orchestration *is* the loop — that is what the harness is for.

The model is forced to answer through a tool whose input schema is the answer shape, and
the result is parsed with zod on the way back. The first makes a well-formed answer
likely; the second makes a malformed one impossible to act on.

`rules` are passed separately from `facts` on purpose. Facts are data to reason over;
rules are policy the agent must not contradict, and keeping them apart means changing
policy is a change to one array rather than an edit to prose somebody has to re-read.

Confidence is honest, and low confidence routes to a human. That is the correct outcome
when the facts do not settle the question, not a failure.

## What is deliberately not here

- **A DAG with cycles or dynamic fan-out.** Tasks are declared up front. A workflow that
  needs to spawn N tasks at runtime would need a different model, and neither of these
  workflows does.
- **Distributed tracing.** The event log covers the "what happened to this run" question,
  which is the one people actually ask. OpenTelemetry belongs here once there is more than
  one service.
- **A scheduler.** `system.schedule_run` puts a message on the outbox; something else has
  to act on it. Building a durable timer wheel when cron plus a query would do is the kind
  of thing that makes a system impressive and unmaintainable.
- **Multi-tenancy.** `labels` carries a tenant, and every query can filter on it, but
  nothing enforces isolation. Doing that properly means row-level security, and it should
  be done when there is a second tenant, not before.
