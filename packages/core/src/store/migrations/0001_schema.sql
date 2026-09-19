-- The durable execution schema.
--
-- Design notes that are not obvious from the DDL:
--
--  * `version` on runs, tasks and approvals is an optimistic-concurrency token. Every
--    update carries the version it read and bumps it; a mismatch is a conflict the caller
--    retries. Pessimistic locking here would serialise the whole engine.
--
--  * Idempotency is a unique index, not application logic. Two webhook retries racing
--    means one of them gets a constraint violation, which is exactly the outcome we want
--    and the only one a database can guarantee.
--
--  * `events` has no update or delete path. It is the audit trail; the run and task rows
--    are the current state, and this is how that state came to be.

CREATE TABLE IF NOT EXISTS runs (
  id                TEXT PRIMARY KEY,
  workflow          TEXT        NOT NULL,
  workflow_version  INTEGER     NOT NULL,
  status            TEXT        NOT NULL,
  subject_type      TEXT        NOT NULL,
  subject_id        TEXT        NOT NULL,
  input             JSONB       NOT NULL DEFAULT '{}'::jsonb,
  context           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key   TEXT,
  version           INTEGER     NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at        TIMESTAMPTZ,
  finished_at       TIMESTAMPTZ,
  error             JSONB,
  labels            JSONB       NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT runs_status_valid CHECK (
    status IN ('pending','running','waiting_approval','waiting_timer','succeeded','failed','cancelled')
  ),
  -- A finished run has a finish time, and an unfinished one does not. Enforcing it here
  -- means no dashboard has to defend against the impossible combination.
  CONSTRAINT runs_finished_consistent CHECK (
    (status IN ('succeeded','failed','cancelled')) = (finished_at IS NOT NULL)
  )
);

-- Idempotency is scoped to the workflow: the same business key can legitimately start a
-- collections run and a follow-up run.
CREATE UNIQUE INDEX IF NOT EXISTS runs_idempotency_uq
  ON runs (workflow, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS runs_status_created_idx ON runs (status, created_at DESC);
CREATE INDEX IF NOT EXISTS runs_subject_idx        ON runs (subject_type, subject_id);
CREATE INDEX IF NOT EXISTS runs_labels_gin         ON runs USING gin (labels jsonb_path_ops);

CREATE TABLE IF NOT EXISTS tasks (
  id                TEXT PRIMARY KEY,
  run_id            TEXT        NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  key               TEXT        NOT NULL,
  handler           TEXT        NOT NULL,
  status            TEXT        NOT NULL,
  depends_on        TEXT[]      NOT NULL DEFAULT '{}',
  input             JSONB       NOT NULL DEFAULT '{}'::jsonb,
  output            JSONB,
  attempt           INTEGER     NOT NULL DEFAULT 0,
  max_attempts      INTEGER     NOT NULL DEFAULT 3,
  leased_by         TEXT,
  lease_expires_at  TIMESTAMPTZ,
  run_after         TIMESTAMPTZ,
  approval_id       TEXT,
  version           INTEGER     NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ,
  error             JSONB,

  CONSTRAINT tasks_status_valid CHECK (
    status IN ('pending','ready','leased','waiting_approval','waiting_timer',
               'succeeded','failed','skipped','quarantined','cancelled')
  ),
  -- A task key is unique within a run, which is what lets dependencies be expressed by
  -- name instead of by id.
  CONSTRAINT tasks_key_uq UNIQUE (run_id, key),
  -- A leased task has a holder and a deadline; an unleased one has neither. Half-set
  -- lease state is the bug that makes lease reclamation unreliable.
  CONSTRAINT tasks_lease_consistent CHECK (
    (status = 'leased') = (leased_by IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CONSTRAINT tasks_attempt_bounded CHECK (attempt >= 0 AND attempt <= max_attempts + 1)
);

-- The index the worker loop lives on. Partial, because only ready tasks are ever leased
-- and the others are dead weight in a queue index.
CREATE INDEX IF NOT EXISTS tasks_ready_idx
  ON tasks (run_after NULLS FIRST, created_at)
  WHERE status = 'ready';

-- The index the lease reaper lives on.
CREATE INDEX IF NOT EXISTS tasks_lease_idx
  ON tasks (lease_expires_at)
  WHERE status = 'leased';

CREATE INDEX IF NOT EXISTS tasks_run_idx     ON tasks (run_id, created_at);
CREATE INDEX IF NOT EXISTS tasks_handler_idx ON tasks (handler) WHERE status = 'ready';

CREATE TABLE IF NOT EXISTS task_attempts (
  id           TEXT PRIMARY KEY,
  task_id      TEXT        NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  run_id       TEXT        NOT NULL REFERENCES runs (id)  ON DELETE CASCADE,
  attempt      INTEGER     NOT NULL,
  worker_id    TEXT        NOT NULL,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  outcome      TEXT,
  error        JSONB,
  duration_ms  INTEGER,

  CONSTRAINT task_attempts_outcome_valid CHECK (
    outcome IS NULL OR outcome IN ('succeeded','failed','lease_expired','cancelled')
  ),
  CONSTRAINT task_attempts_uq UNIQUE (task_id, attempt)
);

CREATE INDEX IF NOT EXISTS task_attempts_task_idx ON task_attempts (task_id, attempt);

CREATE TABLE IF NOT EXISTS approvals (
  id              TEXT PRIMARY KEY,
  run_id          TEXT        NOT NULL REFERENCES runs (id)  ON DELETE CASCADE,
  task_id         TEXT        NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  summary         TEXT        NOT NULL,
  payload         JSONB       NOT NULL,
  required_roles  TEXT[]      NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'pending',
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  decided_at      TIMESTAMPTZ,
  decided_by      TEXT,
  decision_note   TEXT,
  edited_payload  JSONB,
  version         INTEGER     NOT NULL DEFAULT 0,

  CONSTRAINT approvals_status_valid CHECK (
    status IN ('pending','approved','rejected','expired','cancelled')
  ),
  -- A decided approval records who decided it. Without this, an audit trail can contain
  -- "approved" with nobody's name against it, which is worse than no record at all.
  CONSTRAINT approvals_decision_complete CHECK (
    (status = 'pending') OR (decided_at IS NOT NULL AND decided_by IS NOT NULL)
  ),
  CONSTRAINT approvals_roles_present CHECK (cardinality(required_roles) > 0)
);

-- The approval inbox, and the expiry sweeper.
CREATE INDEX IF NOT EXISTS approvals_pending_idx ON approvals (expires_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS approvals_run_idx     ON approvals (run_id, requested_at);

CREATE TABLE IF NOT EXISTS events (
  id        TEXT PRIMARY KEY,
  run_id    TEXT        NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  task_id   TEXT        REFERENCES tasks (id) ON DELETE CASCADE,
  type      TEXT        NOT NULL,
  sequence  INTEGER     NOT NULL,
  actor     TEXT        NOT NULL,
  payload   JSONB       NOT NULL DEFAULT '{}'::jsonb,
  at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Sequence is per run and gapless, so events can be ordered and replayed without
  -- trusting clocks. Two events in the same millisecond are ordinary; two with the same
  -- sequence are a bug.
  CONSTRAINT events_sequence_uq UNIQUE (run_id, sequence)
);

CREATE INDEX IF NOT EXISTS events_run_idx  ON events (run_id, sequence);
CREATE INDEX IF NOT EXISTS events_type_idx ON events (type, at DESC);

CREATE TABLE IF NOT EXISTS outbox (
  id               TEXT PRIMARY KEY,
  run_id           TEXT        NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  task_id          TEXT        REFERENCES tasks (id) ON DELETE CASCADE,
  channel          TEXT        NOT NULL,
  payload          JSONB       NOT NULL,
  idempotency_key  TEXT        NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'pending',
  attempts         INTEGER     NOT NULL DEFAULT 0,
  max_attempts     INTEGER     NOT NULL DEFAULT 5,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at     TIMESTAMPTZ,
  last_error       TEXT,

  CONSTRAINT outbox_status_valid CHECK (status IN ('pending','delivered','failed','abandoned')),
  -- The guarantee the outbox exists to provide: one effect per key, ever.
  CONSTRAINT outbox_idempotency_uq UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS outbox_due_idx ON outbox (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS outbox_run_idx ON outbox (run_id, created_at);

-- Keeps `updated_at` honest without every caller remembering to set it.
CREATE OR REPLACE FUNCTION harness_touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS runs_touch ON runs;
CREATE TRIGGER runs_touch BEFORE UPDATE ON runs
  FOR EACH ROW EXECUTE FUNCTION harness_touch_updated_at();

DROP TRIGGER IF EXISTS tasks_touch ON tasks;
CREATE TRIGGER tasks_touch BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION harness_touch_updated_at();
