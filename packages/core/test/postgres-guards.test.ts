import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { migrate, loadMigrations, reset } from "../src/store/migrate";
import { RUN_TRANSITIONS, TASK_TRANSITIONS } from "../src/domain/state-machine";
import { PostgresStore } from "../src/store/postgres";
import { makeApproval, makeRun, makeTask } from "./store-contract";

/**
 * The database's own guards.
 *
 * The engine checks every transition before it writes, so in normal operation none of
 * this ever fires. It exists for the case the engine cannot cover: a rolling deploy, where
 * two versions of the engine are live at once and the older one tries something the newer
 * schema forbids. The only component in a position to refuse that is Postgres.
 *
 * The first test is the important one. It asserts the SQL transition table and the
 * TypeScript one agree, edge for edge — a claim made in a comment in both files, which
 * would otherwise be true only until somebody edited one of them.
 */

const url = process.env.DATABASE_URL ?? "postgres://harness:harness@127.0.0.1:55432/harness";
const enabled = process.env.HARNESS_TEST_POSTGRES === "1";

const suite = enabled ? describe : describe.skip;

suite("postgres guards", () => {
  let pool: pg.Pool;
  let store: PostgresStore;

  beforeAll(async () => {
    store = new PostgresStore({ connectionString: url });
    pool = store.rawPool;
    await migrate(pool);
  });

  afterAll(async () => {
    await store.close();
  });

  async function freshRun() {
    const run = makeRun();
    await store.transaction((tx) => tx.insertRun(run));
    return run;
  }

  it("agrees with the TypeScript state machine, edge for edge", async () => {
    const runStatuses = Object.keys(RUN_TRANSITIONS) as Array<keyof typeof RUN_TRANSITIONS>;
    const taskStatuses = Object.keys(TASK_TRANSITIONS) as Array<keyof typeof TASK_TRANSITIONS>;

    for (const from of runStatuses) {
      for (const to of runStatuses) {
        const { rows } = await pool.query<{ ok: boolean }>(
          "SELECT harness_run_transition_ok($1, $2) AS ok",
          [from, to],
        );
        const expected = from === to || RUN_TRANSITIONS[from].includes(to);
        expect(rows[0]?.ok, `run ${from} -> ${to}`).toBe(expected);
      }
    }

    for (const from of taskStatuses) {
      for (const to of taskStatuses) {
        const { rows } = await pool.query<{ ok: boolean }>(
          "SELECT harness_task_transition_ok($1, $2) AS ok",
          [from, to],
        );
        const expected = from === to || TASK_TRANSITIONS[from].includes(to);
        expect(rows[0]?.ok, `task ${from} -> ${to}`).toBe(expected);
      }
    }
  });

  it("refuses to resurrect a finished task, whatever the caller thinks", async () => {
    const run = await freshRun();
    const task = makeTask(run.id, { status: "succeeded", finishedAt: new Date() });
    await store.transaction((tx) => tx.insertTasks([task]));

    // Straight SQL, bypassing the engine entirely - this is what an old deployment does.
    await expect(
      pool.query("UPDATE tasks SET status = 'leased', leased_by = 'ghost', lease_expires_at = now(), version = version + 1 WHERE id = $1", [
        task.id,
      ]),
    ).rejects.toThrow(/not a legal transition/);
  });

  it("refuses a write that does not move the version forward", async () => {
    const run = await freshRun();
    await expect(pool.query("UPDATE runs SET status = 'running' WHERE id = $1", [run.id])).rejects.toThrow(
      /version must increase/,
    );
  });

  it("refuses an attempt count that goes backwards", async () => {
    const run = await freshRun();
    const task = makeTask(run.id, { attempt: 2 });
    await store.transaction((tx) => tx.insertTasks([task]));

    await expect(
      pool.query("UPDATE tasks SET attempt = 1, version = version + 1 WHERE id = $1", [task.id]),
    ).rejects.toThrow(/attempt cannot decrease/);
  });

  it("refuses to re-decide an approval", async () => {
    const run = await freshRun();
    const task = makeTask(run.id, { status: "waiting_approval" });
    await store.transaction((tx) => tx.insertTasks([task]));

    const approval = makeApproval(run.id, task.id, {
      status: "approved",
      decidedAt: new Date(),
      decidedBy: "ana",
    });
    await store.transaction((tx) => tx.insertApproval(approval));

    await expect(
      pool.query("UPDATE approvals SET status = 'rejected', version = version + 1 WHERE id = $1", [approval.id]),
    ).rejects.toThrow(/was already approved/);
  });

  it("will not let anyone edit or delete the audit trail", async () => {
    const run = await freshRun();
    await store.transaction((tx) =>
      tx.appendEvent({ runId: run.id, taskId: null, type: "run.created", actor: "test", payload: {} }),
    );

    await expect(pool.query("UPDATE events SET actor = 'somebody else' WHERE run_id = $1", [run.id])).rejects.toThrow(
      /append-only/,
    );
    await expect(pool.query("DELETE FROM events WHERE run_id = $1", [run.id])).rejects.toThrow(/append-only/);
  });

  it("refuses a finished run with no finish time", async () => {
    const run = await freshRun();
    // Get to `running` legitimately first: the transition trigger runs before the CHECK
    // constraint, so pending -> succeeded would be refused for the wrong reason and this
    // test would pass without proving anything.
    await store.transaction((tx) => tx.updateRun(run.id, run.version, { status: "running" }));

    await expect(
      pool.query("UPDATE runs SET status = 'succeeded', version = version + 1 WHERE id = $1", [run.id]),
    ).rejects.toThrow(/runs_finished_consistent/);
  });

  it("refuses a leased task with no lease", async () => {
    const run = await freshRun();
    const task = makeTask(run.id);
    await store.transaction((tx) => tx.insertTasks([task]));

    await expect(
      pool.query("UPDATE tasks SET status = 'leased', version = version + 1 WHERE id = $1", [task.id]),
    ).rejects.toThrow(/tasks_lease_consistent/);
  });

  it("refuses two tasks with the same key in one run", async () => {
    const run = await freshRun();
    await expect(
      store.transaction((tx) =>
        tx.insertTasks([makeTask(run.id, { key: "same" }), makeTask(run.id, { key: "same" })]),
      ),
    ).rejects.toThrow(/tasks_key_uq/);
  });

  it("refuses a second outbox message for the same key", async () => {
    const run = await freshRun();
    const message = {
      runId: run.id,
      taskId: null,
      channel: "email.send",
      payload: {},
      idempotencyKey: "one-and-only",
      status: "pending" as const,
      attempts: 0,
      maxAttempts: 5,
      nextAttemptAt: new Date(),
    };

    const first = await store.transaction((tx) => tx.enqueueOutbox(message));
    const second = await store.transaction((tx) => tx.enqueueOutbox({ ...message, payload: { different: true } }));

    expect(second.id).toBe(first.id);
    // The first payload wins; the duplicate is discarded rather than overwriting it.
    expect(second.payload).toEqual({});
  });
});

suite("migrations", () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: url });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("is idempotent", async () => {
    const first = await migrate(pool);
    const second = await migrate(pool);

    expect(second.applied).toEqual([]);
    expect(second.skipped.length).toBeGreaterThanOrEqual(first.applied.length + first.skipped.length);
  });

  it("refuses a migration that has been edited since it ran", async () => {
    await migrate(pool);
    const [first] = loadMigrations();
    if (!first) throw new Error("no migrations found");

    await pool.query("UPDATE harness_migrations SET checksum = 'deadbeef' WHERE name = $1", [first.name]);
    await expect(migrate(pool)).rejects.toThrow(/has changed since it was applied/);

    // Put it back so the rest of the suite still has a working database.
    await pool.query("UPDATE harness_migrations SET checksum = $2 WHERE name = $1", [first.name, first.checksum]);
  });

  it("rebuilds cleanly from nothing", async () => {
    await reset(pool);
    const result = await migrate(pool);
    expect(result.applied.length).toBeGreaterThan(0);

    const { rows } = await pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
    );
    const tables = rows.map((row) => row.table_name);
    expect(tables).toEqual(
      expect.arrayContaining(["approvals", "events", "harness_migrations", "outbox", "runs", "task_attempts", "tasks"]),
    );
  });
});
