# Operations

For whoever is on call.

## Running it

```bash
docker compose up --build
```

Postgres, the API on :3000, two workers, and the console on :3100. The API migrates on
boot, holding an advisory lock, so several instances starting together do not race.

Locally, without Docker:

```bash
npm install
npm run db:up          # just Postgres
npm run db:migrate
npm run seed           # a few runs to look at
npm run dev:api        # :3000
npm run dev:console    # :3100
```

With no `DATABASE_URL` it runs entirely in memory, with a stub Odoo and the rules brain.
`/health` says which of those is the case — it does not pretend.

## The three numbers to watch

| | Means | Do |
|---|---|---|
| `quarantinedTasks > 0` | Something exhausted its retries and a person has to look | Read the task error, fix the cause, requeue |
| `outboxFailed > 0` | An effect was abandoned after five attempts. **Something did not happen** | Check the channel. Re-enqueue by hand or do it manually |
| `pendingApprovals` growing | Nobody is reading the approval queue | Chase a human. Approvals expire, and an expired approval means the chase did not happen |

All three are on `GET /stats` and in the console header.

## Diagnosing a run

```bash
curl -s localhost:3000/runs/run_abc | jq
```

The response carries the run, its tasks, its approvals and its **full event log**. Read
the event log first — it is ordered, gapless per run, and says who caused each change.

```
1  run.created        ar_collections for 5001         — scheduler
2  task.created       fetch_invoice                   — scheduler
...
9  task.leased        attempt 1                       — worker-7-a3f2
10 task.failed        odoo.session_expired: Access…   — worker-7-a3f2
11 task.retry_scheduled  odoo.session_expired, retrying in 2400ms
12 task.leased        attempt 2                       — worker-7-a3f2
13 task.succeeded     fetch_invoice on attempt 2
...
21 approval.requested Send a firm reminder to Harrow & Finch…
34 approval.approved  checked with the account manager — ana@example.com
```

That is usually the whole investigation.

## Symptoms

### Nothing is being picked up

Tasks sit in `ready` and no worker leases them.

1. Is a worker running? `docker compose ps`, or check for `worker … started` in the logs.
2. Is `run_after` in the future? A retry backoff or a scheduled follow-up is waiting.
   `SELECT key, run_after FROM tasks WHERE status = 'ready' ORDER BY run_after;`
3. Is the worker filtered to handlers that do not include these tasks?
   (`handlerFilter` / `WORKER_HANDLERS`.)

### The same task runs over and over

Almost always a lease expiring mid-handler, so the reaper reclaims it and another worker
starts again.

```sql
SELECT task_id, count(*), max(attempt) FROM task_attempts GROUP BY task_id ORDER BY 2 DESC LIMIT 10;
```

If one task has many attempts with `lease_expired` outcomes, the handler is taking longer
than the lease and not heartbeating. Either call `heartbeat()` inside it or raise
`WORKER_LEASE_MS`. Prefer the heartbeat: raising the lease slows down recovery for
everything else.

### A run says `waiting_approval` and there is no approval

Should be impossible, but if it happens:

```sql
SELECT t.id, t.key, t.approval_id, a.status
FROM tasks t LEFT JOIN approvals a ON a.id = t.approval_id
WHERE t.status = 'waiting_approval';
```

A null `approval_id` means a gate suspended without creating an approval, which is a bug —
capture the run and its events before touching anything. Requeue the task to unstick it.

### Duplicate emails

The outbox exists to prevent this, so check where the duplication is:

```sql
SELECT idempotency_key, count(*) FROM outbox GROUP BY 1 HAVING count(*) > 1;
```

Empty, as it will be — the key is unique. So either two *runs* were created for the same
subject (check `idempotency_key` on `runs`; the caller probably did not send one), or the
downstream provider retried and did not honour the key.

### Everything is slow

```sql
SELECT status, count(*) FROM tasks GROUP BY status;
SELECT now() - lease_expires_at AS overdue, count(*) FROM tasks WHERE status = 'leased' GROUP BY 1;
```

Many `ready` and few `leased` means not enough worker capacity — raise
`WORKER_CONCURRENCY` or add replicas. Many `leased` with expired leases means workers are
dying or blocked; check whether Odoo is timing out.

## Playbooks

### Requeue a quarantined task

Fix the cause first. Then:

```bash
curl -X POST localhost:3000/tasks/tsk_abc/requeue -H "x-harness-roles: operator" -H "x-harness-user: you"
```

Attempts reset to zero, and a run that had failed goes back to `running`.

### Stop a run

```bash
curl -X POST localhost:3000/runs/run_abc/cancel \
  -H "content-type: application/json" -H "x-harness-roles: operator" -H "x-harness-user: you" \
  -d '{"reason":"Customer paid this morning"}'
```

Anything already finished stays finished. The reason goes on the record.

### Stop everything, now

Scale workers to zero. Runs stay exactly where they are; leases expire and the tasks
return to `ready`, so nothing is lost and work resumes when you scale back up.

```bash
docker compose up -d --scale worker=0
```

### Replay an incident locally

`MemoryStore.snapshot()` serialises a whole store to JSON and `MemoryStore.from()` loads
it back. Capture a snapshot mid-incident and replay it on your laptop against the same
engine. Worth more than any amount of logging.

## Deploying

Workers drain on SIGTERM: they stop leasing and finish what they hold. Give them at least
30 seconds (`stop_grace_period: 45s` in the compose file, `terminationGracePeriodSeconds`
on Kubernetes). Killing one early is survivable — the leases expire and the tasks are
retried — but it turns every deploy into a recovery event.

Migrations run on API boot under an advisory lock. During a rolling deploy two engine
versions are briefly live at once, which is exactly what the database-level state-machine
triggers are for: an old instance attempting an illegal transition is refused rather than
corrupting a run.

The migration runner refuses a file whose checksum has changed since it ran. Add a new
migration; never edit one that has been applied.

## What to alert on

- `quarantinedTasks > 0` — page during working hours.
- `outboxFailed > 0` — page. Something did not happen and nobody has been told.
- `pendingApprovals` older than half the expiry window — nudge the humans, not on-call.
- API 5xx rate — the usual.
- Worker heartbeat absent for two lease periods — the fleet is down.

Do not alert on failed *tasks*. Retries are normal and a page for every transient Odoo
timeout trains people to ignore the pager.
