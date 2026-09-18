-- The state machine, enforced in the database.
--
-- The engine already checks every transition before it writes. This is the second line,
-- and it is not redundant: the engine is deployed code, and during a rolling deploy two
-- versions of it are live at once. A worker running yesterday's build can try to move a
-- task from `succeeded` back to `leased`, and the only thing in a position to refuse that
-- is the database.
--
-- Kept in the same shape as `domain/state-machine.ts` on purpose. A test asserts the two
-- tables agree, so they cannot drift.

CREATE OR REPLACE FUNCTION harness_run_transition_ok(from_status TEXT, to_status TEXT)
RETURNS BOOLEAN AS $$
BEGIN
  IF from_status = to_status THEN RETURN TRUE; END IF;
  RETURN CASE from_status
    WHEN 'pending'          THEN to_status IN ('running','cancelled','failed')
    WHEN 'running'          THEN to_status IN ('waiting_approval','waiting_timer','succeeded','failed','cancelled')
    WHEN 'waiting_approval' THEN to_status IN ('running','failed','cancelled')
    WHEN 'waiting_timer'    THEN to_status IN ('running','failed','cancelled')
    ELSE FALSE  -- succeeded, failed and cancelled are terminal
  END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION harness_task_transition_ok(from_status TEXT, to_status TEXT)
RETURNS BOOLEAN AS $$
BEGIN
  IF from_status = to_status THEN RETURN TRUE; END IF;
  RETURN CASE from_status
    WHEN 'pending'          THEN to_status IN ('ready','skipped','cancelled')
    WHEN 'ready'            THEN to_status IN ('leased','skipped','cancelled','waiting_approval')
    -- 'ready' is in this list because that is how a crashed worker's task is recovered.
    WHEN 'leased'           THEN to_status IN ('succeeded','failed','ready','waiting_timer',
                                               'waiting_approval','quarantined','cancelled')
    WHEN 'waiting_approval' THEN to_status IN ('ready','skipped','failed','cancelled')
    WHEN 'waiting_timer'    THEN to_status IN ('ready','cancelled','failed')
    -- 'failed' -> 'ready' is a human requeueing it after fixing the cause.
    WHEN 'failed'           THEN to_status IN ('ready','quarantined')
    ELSE FALSE  -- succeeded, skipped, quarantined and cancelled are terminal
  END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION harness_guard_run_transition() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT harness_run_transition_ok(OLD.status, NEW.status) THEN
    RAISE EXCEPTION 'run %: % -> % is not a legal transition', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- The version must move forward on every write. A caller that forgets is a caller that
  -- has defeated optimistic concurrency for everyone else.
  IF NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'run %: version must increase (was %, got %)', OLD.id, OLD.version, NEW.version
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION harness_guard_task_transition() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT harness_task_transition_ok(OLD.status, NEW.status) THEN
    RAISE EXCEPTION 'task %: % -> % is not a legal transition', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'task %: version must increase (was %, got %)', OLD.id, OLD.version, NEW.version
      USING ERRCODE = 'check_violation';
  END IF;

  -- An attempt count that goes backwards means a retry has been double-counted somewhere,
  -- and the symptom of that is a task that never exhausts its attempts.
  IF NEW.attempt < OLD.attempt THEN
    RAISE EXCEPTION 'task %: attempt cannot decrease (was %, got %)', OLD.id, OLD.attempt, NEW.attempt
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS runs_guard ON runs;
CREATE TRIGGER runs_guard BEFORE UPDATE ON runs
  FOR EACH ROW EXECUTE FUNCTION harness_guard_run_transition();

DROP TRIGGER IF EXISTS tasks_guard ON tasks;
CREATE TRIGGER tasks_guard BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION harness_guard_task_transition();

-- An approval decision is final. Re-deciding one is not a valid operation, and allowing
-- it would mean the audit trail no longer says what was agreed.
CREATE OR REPLACE FUNCTION harness_guard_approval() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status <> 'pending' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'approval % was already %', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'approval %: version must increase', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS approvals_guard ON approvals;
CREATE TRIGGER approvals_guard BEFORE UPDATE ON approvals
  FOR EACH ROW EXECUTE FUNCTION harness_guard_approval();

-- The audit trail is append-only. Not "we agreed not to update it" - the database refuses.
CREATE OR REPLACE FUNCTION harness_events_append_only() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'events is append-only; % is not permitted', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS events_immutable ON events;
CREATE TRIGGER events_immutable BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION harness_events_append_only();
