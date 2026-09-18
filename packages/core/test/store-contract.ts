import { describe, expect, it, beforeEach, afterAll } from "vitest";
import type { Approval, OutboxMessage, Run, Task } from "../src/domain/types";
import { VersionConflictError, type Store } from "../src/store/port";

/**
 * The store contract.
 *
 * Every implementation runs this identical suite. That is the whole justification for
 * having an in-memory store at all: it is not a convenient fiction, it is the same
 * contract held to the same tests, so a behaviour proved here holds in Postgres too.
 *
 * The tests that matter most are the concurrency ones. Leasing, optimistic versioning and
 * outbox deduplication are where a store implementation quietly differs, and where the
 * difference costs you a double-sent email in production rather than a failing test.
 */

let counter = 0;
const uid = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(++counter).toString(36).padStart(4, "0")}`;

/**
 * Fixtures produce *valid* entities.
 *
 * The schema has CHECK constraints saying a terminal run has a finish time and a decided
 * approval has a decider. A fixture that ignores them is not testing a shortcut, it is
 * testing data the system will never contain — so the defaults derive those fields rather
 * than leaving them null.
 */
export function makeRun(overrides: Partial<Run> = {}): Run {
  const now = new Date("2026-09-19T09:00:00.000Z");
  const status = overrides.status ?? "pending";
  const terminal = status === "succeeded" || status === "failed" || status === "cancelled";
  return {
    id: uid("run"),
    workflow: "ar_collections",
    workflowVersion: 1,
    status: "pending",
    subjectType: "account.move",
    subjectId: "INV/2026/0042",
    input: { invoiceId: 42 },
    context: {},
    idempotencyKey: null,
    version: 0,
    createdAt: now,
    updatedAt: now,
    startedAt: terminal ? now : null,
    finishedAt: terminal ? now : null,
    error: null,
    labels: {},
    ...overrides,
  };
}

export function makeTask(runId: string, overrides: Partial<Task> = {}): Task {
  const now = new Date("2026-09-19T09:00:00.000Z");
  return {
    id: uid("tsk"),
    runId,
    // Unique by default: task keys are unique within a run, so a shared default would
    // make any test with two tasks fail for the wrong reason.
    key: uid("key"),
    handler: "odoo.fetch_invoice",
    status: "ready",
    dependsOn: [],
    input: {},
    output: null,
    attempt: 0,
    maxAttempts: 3,
    leasedBy: null,
    leaseExpiresAt: null,
    runAfter: null,
    approvalId: null,
    version: 0,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
    error: null,
    ...overrides,
  };
}

export function makeApproval(runId: string, taskId: string, overrides: Partial<Approval> = {}): Approval {
  const now = new Date("2026-09-19T09:00:00.000Z");
  const decided = (overrides.status ?? "pending") !== "pending";
  return {
    id: uid("apr"),
    runId,
    taskId,
    summary: "Send a firm reminder to Acme Ltd for GBP 4,200",
    payload: { subject: "Payment reminder", body: "..." },
    requiredRoles: ["ar_manager"],
    status: "pending",
    requestedAt: now,
    expiresAt: new Date(now.getTime() + 48 * 3_600_000),
    decidedAt: decided ? now : null,
    decidedBy: decided ? "fixture" : null,
    decisionNote: null,
    editedPayload: null,
    version: 0,
    ...overrides,
  };
}

export interface StoreFactory {
  name: string;
  create(): Promise<Store>;
  /** Wipe between tests. */
  reset(store: Store): Promise<void>;
}

export function runStoreContract(factory: StoreFactory): void {
  describe(`store contract: ${factory.name}`, () => {
    let store: Store;

    beforeEach(async () => {
      store ??= await factory.create();
      await factory.reset(store);
    });

    afterAll(async () => {
      await store?.close();
    });

    /* ----------------------------------------------------------------- runs -- */

    it("round-trips a run", async () => {
      const run = makeRun();
      await store.transaction((tx) => tx.insertRun(run));

      const found = await store.reads.getRun(run.id);
      expect(found?.workflow).toBe("ar_collections");
      expect(found?.input).toEqual({ invoiceId: 42 });
      expect(found?.createdAt.toISOString()).toBe(run.createdAt.toISOString());
    });

    it("returns the first run for a repeated idempotency key", async () => {
      const first = makeRun({ idempotencyKey: "invoice-42-day-3" });
      const second = makeRun({ idempotencyKey: "invoice-42-day-3" });

      const a = await store.transaction((tx) => tx.insertRun(first));
      const b = await store.transaction((tx) => tx.insertRun(second));

      expect(b.id).toBe(a.id);
      const page = await store.reads.listRuns({});
      expect(page.items).toHaveLength(1);
    });

    it("scopes idempotency keys to a workflow", async () => {
      await store.transaction((tx) => tx.insertRun(makeRun({ idempotencyKey: "k1" })));
      await store.transaction((tx) => tx.insertRun(makeRun({ idempotencyKey: "k1", workflow: "lead_followup" })));

      const page = await store.reads.listRuns({});
      expect(page.items).toHaveLength(2);
    });

    it("rejects a stale write", async () => {
      const run = makeRun();
      await store.transaction((tx) => tx.insertRun(run));
      await store.transaction((tx) => tx.updateRun(run.id, 0, { status: "running" }));

      await expect(store.transaction((tx) => tx.updateRun(run.id, 0, { status: "failed" }))).rejects.toThrow(
        VersionConflictError,
      );
      expect((await store.reads.getRun(run.id))?.status).toBe("running");
    });

    it("filters runs by status, workflow and label", async () => {
      await store.transaction(async (tx) => {
        await tx.insertRun(makeRun({ status: "running", labels: { tenant: "acme" } }));
        await tx.insertRun(makeRun({ status: "failed", labels: { tenant: "acme" } }));
        await tx.insertRun(makeRun({ status: "running", workflow: "lead_followup", labels: { tenant: "other" } }));
      });

      expect((await store.reads.listRuns({ status: ["running"] })).items).toHaveLength(2);
      expect((await store.reads.listRuns({ workflow: "lead_followup" })).items).toHaveLength(1);
      expect((await store.reads.listRuns({ label: { key: "tenant", value: "acme" } })).items).toHaveLength(2);
    });

    it("pages without repeating or dropping a run", async () => {
      await store.transaction(async (tx) => {
        for (let i = 0; i < 7; i++) {
          await tx.insertRun(makeRun({ createdAt: new Date(Date.UTC(2026, 8, 19, 9, i)) }));
        }
      });

      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await store.reads.listRuns({ limit: 3, ...(cursor ? { cursor } : {}) });
        seen.push(...page.items.map((run) => run.id));
        cursor = page.nextCursor;
      } while (cursor);

      expect(seen).toHaveLength(7);
      expect(new Set(seen).size).toBe(7);
    });

    /* ---------------------------------------------------------------- tasks -- */

    it("leases a ready task exactly once", async () => {
      const run = makeRun();
      const task = makeTask(run.id);
      await store.transaction(async (tx) => {
        await tx.insertRun(run);
        await tx.insertTasks([task]);
      });

      const now = new Date("2026-09-19T10:00:00.000Z");
      const first = await store.transaction((tx) =>
        tx.leaseTasks({ workerId: "worker-a", limit: 10, leaseMs: 30_000, now }),
      );
      const second = await store.transaction((tx) =>
        tx.leaseTasks({ workerId: "worker-b", limit: 10, leaseMs: 30_000, now }),
      );

      expect(first).toHaveLength(1);
      expect(second).toHaveLength(0);
      expect(first[0]?.leasedBy).toBe("worker-a");
      expect(first[0]?.attempt).toBe(1);
    });

    it("does not lease a task that is sleeping", async () => {
      const run = makeRun();
      const now = new Date("2026-09-19T10:00:00.000Z");
      const task = makeTask(run.id, { runAfter: new Date(now.getTime() + 60_000) });
      await store.transaction(async (tx) => {
        await tx.insertRun(run);
        await tx.insertTasks([task]);
      });

      expect(await store.transaction((tx) => tx.leaseTasks({ workerId: "w", limit: 10, leaseMs: 1000, now }))).toHaveLength(0);

      const later = new Date(now.getTime() + 61_000);
      expect(
        await store.transaction((tx) => tx.leaseTasks({ workerId: "w", limit: 10, leaseMs: 1000, now: later })),
      ).toHaveLength(1);
    });

    it("restricts a lease to the handlers a worker asked for", async () => {
      const run = makeRun();
      await store.transaction(async (tx) => {
        await tx.insertRun(run);
        await tx.insertTasks([
          makeTask(run.id, { key: "fetch", handler: "odoo.fetch_invoice" }),
          makeTask(run.id, { key: "draft", handler: "agent.ar_drafter" }),
        ]);
      });

      const leased = await store.transaction((tx) =>
        tx.leaseTasks({
          workerId: "w",
          limit: 10,
          leaseMs: 1000,
          now: new Date("2026-09-19T10:00:00.000Z"),
          handlers: ["agent.ar_drafter"],
        }),
      );

      expect(leased).toHaveLength(1);
      expect(leased[0]?.handler).toBe("agent.ar_drafter");
    });

    it("leases oldest first, so nothing is starved", async () => {
      const run = makeRun();
      await store.transaction(async (tx) => {
        await tx.insertRun(run);
        await tx.insertTasks([
          makeTask(run.id, { key: "new", createdAt: new Date(Date.UTC(2026, 8, 19, 12)) }),
          makeTask(run.id, { key: "old", createdAt: new Date(Date.UTC(2026, 8, 19, 8)) }),
        ]);
      });

      const leased = await store.transaction((tx) =>
        tx.leaseTasks({ workerId: "w", limit: 1, leaseMs: 1000, now: new Date("2026-09-19T13:00:00.000Z") }),
      );
      expect(leased[0]?.key).toBe("old");
    });

    it("returns an expired lease to ready without losing the attempt count", async () => {
      const run = makeRun();
      const task = makeTask(run.id);
      await store.transaction(async (tx) => {
        await tx.insertRun(run);
        await tx.insertTasks([task]);
      });

      const now = new Date("2026-09-19T10:00:00.000Z");
      await store.transaction((tx) => tx.leaseTasks({ workerId: "dead", limit: 1, leaseMs: 1000, now }));

      const later = new Date(now.getTime() + 5_000);
      const reclaimed = await store.transaction((tx) => tx.reclaimExpiredLeases(later, 10));

      expect(reclaimed).toHaveLength(1);
      const after = await store.reads.getTask(task.id);
      expect(after?.status).toBe("ready");
      expect(after?.leasedBy).toBeNull();
      // The attempt stands: it was tried once, whatever the worker did with it.
      expect(after?.attempt).toBe(1);
    });

    it("leaves a live lease alone", async () => {
      const run = makeRun();
      await store.transaction(async (tx) => {
        await tx.insertRun(run);
        await tx.insertTasks([makeTask(run.id)]);
      });

      const now = new Date("2026-09-19T10:00:00.000Z");
      await store.transaction((tx) => tx.leaseTasks({ workerId: "alive", limit: 1, leaseMs: 60_000, now }));
      const reclaimed = await store.transaction((tx) =>
        tx.reclaimExpiredLeases(new Date(now.getTime() + 30_000), 10),
      );
      expect(reclaimed).toHaveLength(0);
    });

    /* ----------------------------------------------------------- transactions -- */

    it("rolls back everything when the unit of work throws", async () => {
      const run = makeRun();
      await expect(
        store.transaction(async (tx) => {
          await tx.insertRun(run);
          await tx.insertTasks([makeTask(run.id)]);
          throw new Error("changed my mind");
        }),
      ).rejects.toThrow("changed my mind");

      expect(await store.reads.getRun(run.id)).toBeNull();
      expect(await store.reads.listTasks(run.id)).toHaveLength(0);
    });

    /* --------------------------------------------------------------- events -- */

    it("numbers events per run, in order", async () => {
      const a = makeRun();
      const b = makeRun();
      await store.transaction(async (tx) => {
        await tx.insertRun(a);
        await tx.insertRun(b);
        await tx.appendEvent({ runId: a.id, taskId: null, type: "run.created", actor: "system", payload: {} });
        await tx.appendEvent({ runId: b.id, taskId: null, type: "run.created", actor: "system", payload: {} });
        await tx.appendEvent({ runId: a.id, taskId: null, type: "run.started", actor: "system", payload: {} });
      });

      const eventsA = await store.reads.listEvents(a.id);
      expect(eventsA.map((event) => event.sequence)).toEqual([1, 2]);
      expect((await store.reads.listEvents(b.id)).map((event) => event.sequence)).toEqual([1]);
      expect(await store.reads.listEvents(a.id, 1)).toHaveLength(1);
    });

    /* ------------------------------------------------------------ approvals -- */

    it("finds only approvals that are pending and past their deadline", async () => {
      const run = makeRun();
      const task = makeTask(run.id, { status: "waiting_approval" });
      const now = new Date("2026-09-19T10:00:00.000Z");

      await store.transaction(async (tx) => {
        await tx.insertRun(run);
        await tx.insertTasks([task]);
        await tx.insertApproval(makeApproval(run.id, task.id, { expiresAt: new Date(now.getTime() - 1000) }));
        await tx.insertApproval(makeApproval(run.id, task.id, { expiresAt: new Date(now.getTime() + 1000) }));
        await tx.insertApproval(
          makeApproval(run.id, task.id, { expiresAt: new Date(now.getTime() - 5000), status: "approved" }),
        );
      });

      const expired = await store.transaction((tx) => tx.findExpiredApprovals(now, 10));
      expect(expired).toHaveLength(1);
    });

    it("refuses a stale approval decision", async () => {
      const run = makeRun();
      const task = makeTask(run.id);
      const approval = makeApproval(run.id, task.id);
      await store.transaction(async (tx) => {
        await tx.insertRun(run);
        await tx.insertTasks([task]);
        await tx.insertApproval(approval);
      });

      const decidedAt = new Date("2026-09-19T11:00:00.000Z");
      await store.transaction((tx) =>
        tx.updateApproval(approval.id, 0, { status: "approved", decidedBy: "ana", decidedAt }),
      );
      await expect(
        store.transaction((tx) =>
          tx.updateApproval(approval.id, 0, { status: "rejected", decidedBy: "bo", decidedAt }),
        ),
      ).rejects.toThrow(VersionConflictError);

      expect((await store.reads.getApproval(approval.id))?.decidedBy).toBe("ana");
    });

    /* --------------------------------------------------------------- outbox -- */

    it("deduplicates outbox messages on their idempotency key", async () => {
      const run = makeRun();
      await store.transaction((tx) => tx.insertRun(run));

      const message: Omit<OutboxMessage, "id" | "createdAt" | "deliveredAt" | "lastError"> = {
        runId: run.id,
        taskId: null,
        channel: "email.send",
        payload: { to: "ap@acme.example" },
        idempotencyKey: "inv-42-reminder-2",
        status: "pending",
        attempts: 0,
        maxAttempts: 5,
        nextAttemptAt: new Date("2026-09-19T10:00:00.000Z"),
      };

      const first = await store.transaction((tx) => tx.enqueueOutbox(message));
      const second = await store.transaction((tx) => tx.enqueueOutbox(message));

      expect(second.id).toBe(first.id);
      expect(await store.reads.listOutbox({})).toHaveLength(1);
    });

    it("claims only messages that are due", async () => {
      const run = makeRun();
      const now = new Date("2026-09-19T10:00:00.000Z");
      await store.transaction(async (tx) => {
        await tx.insertRun(run);
        await tx.enqueueOutbox({
          runId: run.id,
          taskId: null,
          channel: "email.send",
          payload: {},
          idempotencyKey: "due",
          status: "pending",
          attempts: 0,
          maxAttempts: 5,
          nextAttemptAt: new Date(now.getTime() - 1000),
        });
        await tx.enqueueOutbox({
          runId: run.id,
          taskId: null,
          channel: "email.send",
          payload: {},
          idempotencyKey: "later",
          status: "pending",
          attempts: 0,
          maxAttempts: 5,
          nextAttemptAt: new Date(now.getTime() + 60_000),
        });
      });

      const claimed = await store.transaction((tx) => tx.claimOutbox(now, 10));
      expect(claimed.map((message) => message.idempotencyKey)).toEqual(["due"]);
    });

    /* ---------------------------------------------------------------- stats -- */

    it("counts what the console header shows", async () => {
      const run = makeRun({ status: "running" });
      const task = makeTask(run.id, { status: "quarantined" });
      await store.transaction(async (tx) => {
        await tx.insertRun(run);
        await tx.insertTasks([task, makeTask(run.id, { key: "done", status: "succeeded" })]);
        await tx.insertApproval(makeApproval(run.id, task.id));
        await tx.enqueueOutbox({
          runId: run.id,
          taskId: null,
          channel: "email.send",
          payload: {},
          idempotencyKey: "s1",
          status: "pending",
          attempts: 0,
          maxAttempts: 5,
          nextAttemptAt: new Date(),
        });
      });

      const stats = await store.reads.stats();
      expect(stats.runsByStatus.running).toBe(1);
      expect(stats.tasksByStatus.quarantined).toBe(1);
      expect(stats.pendingApprovals).toBe(1);
      expect(stats.outboxPending).toBe(1);
      expect(stats.quarantinedTasks).toBe(1);
    });
  });
}
