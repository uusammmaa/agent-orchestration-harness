# Agent orchestration harness

A durable, approval-gated backend that coordinates LLM agents for accounts-receivable
collections and lead follow-up, integrated with Odoo.

**[Open the console →](https://agent-orchestration-harness.vercel.app)** — it runs the
real engine in your browser session. Approve something and watch the run resume; reject it
and watch nothing get sent.

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

---

## The five guarantees

Everything else in the repo is detail. These are the claims the system makes, and each one
has tests behind it.

**1. A task is executed by one worker at a time.** Leasing is a single
`FOR UPDATE SKIP LOCKED` statement, so ten workers polling the same table do useful work
instead of queueing. A worker may only report on a task it still holds — without that, a
worker whose lease expired can come back and overwrite a newer result.

**2. A crashed worker's work is picked up.** Short leases, extended by heartbeat. An
expired lease returns the task to `ready`, not `failed`: the work may well have been done,
so the safe move is to run it again against an idempotent handler.

**3. Nothing leaves the building without the approval it needs.** And the dependency model
knows the difference between a gate that was skipped because it was not needed and one
that was skipped because somebody said no — see below.

**4. An effect happens exactly once.** Transactional outbox: the email and the decision to
send it commit together, keyed on the run and task rather than the attempt, so a retry
cannot produce a second one.

**5. Every state change has an event explaining it.** Append-only, enforced by a trigger
rather than by agreement.

---

## The decision worth reading the code for

An approval gate suspends a run. Fine. But a **rejected** gate and a gate that was
**never needed** both leave the task `skipped`, and `dependsOn` cannot tell them apart.

So there are two kinds of edge:

| | Means | Used for |
|---|---|---|
| `dependsOn` | must have **settled** — succeeded or skipped | ordering, where a skipped branch should not hold things up |
| `requires` | must have **succeeded** | anything that must not happen without a real success |

```ts
// ar_collections — the gate is mandatory. A rejection or an expiry skips the send.
{ key: "send_message", handler: "effect.send_email", requires: ["approve_message"] }

// lead_followup — review is conditional. It sends whether or not a person read it,
// but never without a draft.
{ key: "send_outreach", requires: ["draft_outreach"], dependsOn: ["review_outreach"] }
```

That asymmetry is the whole difference between the two workflows, and it is declared in
the workflow rather than buried in a handler. It was also a real bug: the first version
treated skipped as settled everywhere, and the integration test caught a rejected approval
being followed by the send it was gating.

---

## The state machine, enforced twice

Legal transitions live in `domain/state-machine.ts` and again in a Postgres trigger. The
engine checks before every write, so the trigger never fires in normal operation.

It exists for the case the engine cannot cover: a rolling deploy, where two versions are
live at once and the older one tries something the newer schema forbids. The only
component in a position to refuse that is the database.

A test asserts the two tables agree, edge for edge — otherwise the claim is true only
until somebody edits one of them.

---

## Two stores, one contract

`PostgresStore` and `MemoryStore` implement the same interface and pass the same 19-test
contract suite. That is the entire justification for the in-memory store: it is not a
convenient fiction, it is the same contract held to the same tests — which is what makes
it safe to host the console on.

Running that suite against real Postgres for the first time found three invariants the
in-memory store was letting through: a terminal run with no finish time, two tasks sharing
a key, and a decided approval with nobody's name on it. All three are enforced in both
now.

---

## The agents

Narrow. Each is given structured facts and asked for a structured judgement, and the
schema of that judgement is fixed by the caller. There is no open-ended tool loop — the
orchestration *is* the loop.

The model answers through a tool whose input schema **is** the answer shape, and the
result is parsed with zod on the way back. The first makes a well-formed answer likely;
the second makes a malformed one impossible to act on.

`rules` are passed separately from `facts`, so changing what an agent may not do is a
change to one array rather than an edit to prose:

```ts
rules: [
  "Never threaten legal action or mention a credit agency.",
  "Never state a figure that is not the outstanding amount given to you.",
  "Always offer a way to raise a query.",
]
```

`RulesBrain` implements the same contract without a model. It powers the hosted console,
keeps the tests hermetic, and means a provider outage degrades the system instead of
stopping it.

---

## The two workflows

**`ar_collections`** — an invoice goes overdue. Pull the facts from Odoo, work out where in
the dunning ladder this customer is, have an agent draft a chase, **stop for a human**,
then send and log it back to the ERP.

The ladder is data, not prompt text, because escalation policy is a business decision
finance should be able to read — and it never goes backwards: a customer who has had three
chases does not get the gentle one again because somebody re-dated the invoice.

A **disputed** invoice never reaches a chaser. Chasing somebody who has already complained
is how a collections process turns into a lost customer.

**`lead_followup`** — a lead goes quiet. Enrich, qualify, draft, and send. Human review
only where the value, the account, or the agent's own uncertainty justifies it, because
putting a person in the loop for every £2,000 follow-up fills the queue with rubber-stamps
and the approvals that matter stop being read.

---

## Running it

```bash
docker compose up --build      # postgres, api :3000, two workers, console :3100
```

Or locally:

```bash
npm install
npm run db:up && npm run db:migrate
npm run seed                   # a few runs to look at
npm run dev:api                # :3000, /openapi.json for the routes
npm run dev:console            # :3100
```

Every credential in [`.env.example`](.env.example) is optional. With none of them the
harness runs on an in-memory store, a stub Odoo and the rules brain, and `/health` says so
rather than pretending.

```bash
npm run verify                 # typecheck, lint, 97 tests
HARNESS_TEST_POSTGRES=1 npm test   # 156, including the Postgres contract and guard tests
```

---

## Verification

```
156 tests
  19 × 2  store contract, run identically against Postgres and in-memory
  35      engine: leasing, retries, quarantine, crash recovery, approval gates, cancellation
  13      Postgres guards: SQL/TypeScript state-machine parity, append-only events, migrations
  23      Odoo: real XML-RPC round trips, `false` handling, error classification
  20      workflows end to end: engine + handlers + stub Odoo + outbox dispatch
  27      API over a real socket: routing, problem+json, authorisation
```

The ones that would catch a regression nobody else would are in
`packages/agents/test/workflows.test.ts`: that chasing an invoice actually stops at a
human, that a rejected approval sends nothing, and that a disputed invoice never reaches a
customer.

---

## Repo map

```
packages/core/       engine, state machine, stores, migrations, worker, workflows
packages/odoo/       XML-RPC client, typed Odoo surface, stub server
packages/agents/     brain port, Anthropic + rules implementations, handlers
apps/api/            route table + a thin HTTP layer, OpenAPI from the routes
apps/console/        the ops console
docs/                architecture, operations, Odoo
```

| | |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | The five guarantees, why status is derived, what is deliberately absent |
| [OPERATIONS.md](docs/OPERATIONS.md) | The three numbers to watch, symptoms and playbooks, what to alert on |
| [ODOO.md](docs/ODOO.md) | Connecting, error classification, and the `false`-not-null problem |

---

Built by [Usama Akram](https://github.com/uusammmaa). MIT licensed.
