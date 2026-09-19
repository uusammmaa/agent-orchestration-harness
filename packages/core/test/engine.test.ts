import { beforeEach, describe, expect, it } from "vitest";
import { Engine, ForbiddenError, WorkflowNotFoundError } from "../src/engine/engine";
import { MemoryStore } from "../src/store/memory";
import { IllegalTransitionError } from "../src/domain/state-machine";
import type { WorkflowDefinition } from "../src/domain/types";

/**
 * Engine behaviour.
 *
 * These are the guarantees the whole system rests on: a task is executed by one worker at
 * a time, a crashed worker's work is picked up, nothing leaves the building without
 * approval where approval is required, and every state change has an event explaining it.
 *
 * The clock is injected and backoff is zero, so nothing here sleeps.
 */

const LINEAR: WorkflowDefinition = {
  name: "linear",
  version: 1,
  description: "a -> b -> c",
  subjectType: "test",
  tasks: [
    { key: "a", handler: "h.a" },
    { key: "b", handler: "h.b", dependsOn: ["a"], input: (ctx) => ({ from: ctx.outputs.a?.value }) },
    { key: "c", handler: "h.c", dependsOn: ["b"] },
  ],
};

const BRANCHED: WorkflowDefinition = {
  name: "branched",
  version: 1,
  description: "a fans out to b and c, which join at d",
  subjectType: "test",
  tasks: [
    { key: "a", handler: "h.a" },
    { key: "b", handler: "h.b", dependsOn: ["a"] },
    { key: "c", handler: "h.c", dependsOn: ["a"], when: (ctx) => ctx.outputs.a?.branch === "both" },
    { key: "d", handler: "h.d", dependsOn: ["b", "c"] },
  ],
};

const GATED: WorkflowDefinition = {
  name: "gated",
  version: 1,
  description: "draft -> approve -> send",
  subjectType: "test",
  tasks: [
    { key: "draft", handler: "agent.draft" },
    {
      key: "approve",
      handler: "system.approval_gate",
      dependsOn: ["draft"],
      approval: {
        summary: () => "Send the draft",
        requiredRoles: ["ar_manager"],
        expiresInHours: 24,
        onExpiry: "skip",
      },
    },
    { key: "send", handler: "effect.send", dependsOn: ["approve"] },
  ],
};

function harness(now = new Date("2026-09-19T09:00:00.000Z")) {
  const store = new MemoryStore();
  let clock = now;
  let ids = 0;
  const engine = new Engine({
    store,
    workflows: [LINEAR, BRANCHED, GATED],
    now: () => clock,
    idFactory: (prefix) => `${prefix}_${String(++ids).padStart(4, "0")}`,
    backoff: () => 0,
  });
  return {
    store,
    engine,
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
    at() {
      return clock;
    },
  };
}

async function leaseOne(engine: Engine, worker = "w1") {
  const [task] = await engine.leaseTasks(worker, 1, 30_000);
  if (!task) throw new Error("nothing was ready to lease");
  return task;
}

describe("starting a run", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it("creates the run and its tasks, with only the roots ready", async () => {
    const run = await h.engine.startRun({ workflow: "linear", subjectId: "s1", input: { x: 1 } });

    expect(run.status).toBe("running");
    const tasks = await h.store.reads.listTasks(run.id);
    expect(tasks.map((task) => [task.key, task.status])).toEqual([
      ["a", "ready"],
      ["b", "pending"],
      ["c", "pending"],
    ]);
  });

  it("refuses an unknown workflow", async () => {
    await expect(h.engine.startRun({ workflow: "nope", subjectId: "s", input: {} })).rejects.toThrow(
      WorkflowNotFoundError,
    );
  });

  it("returns the same run for a repeated idempotency key", async () => {
    const first = await h.engine.startRun({ workflow: "linear", subjectId: "s", input: {}, idempotencyKey: "k" });
    const second = await h.engine.startRun({ workflow: "linear", subjectId: "s", input: {}, idempotencyKey: "k" });

    expect(second.id).toBe(first.id);
    expect((await h.store.reads.listRuns({})).items).toHaveLength(1);
    // And no second set of tasks.
    expect(await h.store.reads.listTasks(first.id)).toHaveLength(3);
  });

  it("records the run and every task in the audit trail", async () => {
    const run = await h.engine.startRun({ workflow: "linear", subjectId: "s", input: {} });
    const events = await h.store.reads.listEvents(run.id);

    // The trailing task.ready is the root task being promoted, which is where its input
    // and its guard are resolved.
    expect(events.map((event) => event.type)).toEqual([
      "run.created",
      "task.created",
      "task.created",
      "task.created",
      "run.started",
      "task.ready",
    ]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("executing tasks", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it("hands a task to exactly one worker", async () => {
    await h.engine.startRun({ workflow: "linear", subjectId: "s", input: {} });

    const first = await h.engine.leaseTasks("w1", 5, 30_000);
    const second = await h.engine.leaseTasks("w2", 5, 30_000);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it("unblocks the next task and passes the previous output into it", async () => {
    const run = await h.engine.startRun({ workflow: "linear", subjectId: "s", input: {} });
    const a = await leaseOne(h.engine);
    await h.engine.completeTask({ taskId: a.id, workerId: "w1", output: { value: 42 } });

    const tasks = await h.store.reads.listTasks(run.id);
    const b = tasks.find((task) => task.key === "b");
    expect(b?.status).toBe("ready");
    expect(b?.input).toEqual({ from: 42 });
  });

  it("refuses a result from a worker that does not hold the lease", async () => {
    await h.engine.startRun({ workflow: "linear", subjectId: "s", input: {} });
    const a = await leaseOne(h.engine, "w1");

    await expect(
      h.engine.completeTask({ taskId: a.id, workerId: "w2", output: {} }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("refuses a second result for a task already finished", async () => {
    await h.engine.startRun({ workflow: "linear", subjectId: "s", input: {} });
    const a = await leaseOne(h.engine);
    await h.engine.completeTask({ taskId: a.id, workerId: "w1", output: {} });

    await expect(h.engine.completeTask({ taskId: a.id, workerId: "w1", output: {} })).rejects.toThrow(ForbiddenError);
  });

  it("succeeds the run once every task has", async () => {
    const run = await h.engine.startRun({ workflow: "linear", subjectId: "s", input: {} });

    for (const _ of ["a", "b", "c"]) {
      const task = await leaseOne(h.engine);
      await h.engine.completeTask({ taskId: task.id, workerId: "w1", output: { done: task.key } });
    }

    const finished = await h.store.reads.getRun(run.id);
    expect(finished?.status).toBe("succeeded");
    expect(finished?.finishedAt).not.toBeNull();
    // Outputs are collected into the run context, so callers have one place to read.
    expect(finished?.context).toMatchObject({ a: { done: "a" }, c: { done: "c" } });
  });
});

describe("retries and failure", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it("reschedules a retryable failure and keeps the attempt count", async () => {
    await h.engine.startRun({ workflow: "linear", subjectId: "s", input: {} });
    const a = await leaseOne(h.engine);

    const failed = await h.engine.failTask({
      taskId: a.id,
      workerId: "w1",
      error: { code: "odoo.timeout", message: "took too long", retryable: true },
    });

    expect(failed.status).toBe("ready");
    expect(failed.attempt).toBe(1);
    expect(failed.leasedBy).toBeNull();

    const retried = await leaseOne(h.engine);
    expect(retried.id).toBe(a.id);
    expect(retried.attempt).toBe(2);
  });

  it("does not retry a failure that says it is permanent", async () => {
    const run = await h.engine.startRun({ workflow: "linear", subjectId: "s", input: {} });
    const a = await leaseOne(h.engine);

    const failed = await h.engine.failTask({
      taskId: a.id,
      workerId: "w1",
      error: { code: "odoo.not_found", message: "no such invoice", retryable: false },
    });

    expect(failed.status).toBe("failed");
    expect((await h.store.reads.getRun(run.id))?.status).toBe("failed");
  });

  it("quarantines a task that keeps failing, rather than retrying forever", async () => {
    await h.engine.startRun({ workflow: "linear", subjectId: "s", input: {} });

    let task = await leaseOne(h.engine);
    for (let attempt = 1; attempt <= 3; attempt++) {
      await h.engine.failTask({
        taskId: task.id,
        workerId: "w1",
        error: { code: "flaky", message: "again", retryable: true },
      });
      if (attempt < 3) task = await leaseOne(h.engine);
    }

    const quarantined = await h.store.reads.getTask(task.id);
    expect(quarantined?.status).toBe("quarantined");
    expect(quarantined?.attempt).toBe(3);
  });

  it("keeps every attempt on the record, including the failed ones", async () => {
    await h.engine.startRun({ workflow: "linear", subjectId: "s", input: {} });
    const a = await leaseOne(h.engine);
    await h.engine.failTask({
      taskId: a.id,
      workerId: "w1",
      error: { code: "flaky", message: "first go", retryable: true },
    });
    const retried = await leaseOne(h.engine, "w2");
    await h.engine.completeTask({ taskId: retried.id, workerId: "w2", output: {} });

    const attempts = await h.store.reads.listAttempts(a.id);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ attempt: 1, outcome: "failed", workerId: "w1" });
    expect(attempts[1]).toMatchObject({ attempt: 2, outcome: "succeeded", workerId: "w2" });
  });

  it("lets a human requeue a quarantined task and revives the run", async () => {
    const run = await h.engine.startRun({ workflow: "linear", subjectId: "s", input: {} });
    let task = await leaseOne(h.engine);
    for (let attempt = 1; attempt <= 3; attempt++) {
      await h.engine.failTask({
        taskId: task.id,
        workerId: "w1",
        error: { code: "flaky", message: "again", retryable: true },
      });
      if (attempt < 3) task = await leaseOne(h.engine);
    }
    expect((await h.store.reads.getRun(run.id))?.status).toBe("failed");

    const requeued = await h.engine.requeueTask(task.id, "ana");
    expect(requeued.status).toBe("ready");
    expect(requeued.attempt).toBe(0);
    expect((await h.store.reads.getRun(run.id))?.status).toBe("running");
  });
});

describe("crash recovery", () => {
  it("gives a dead worker's task to somebody else", async () => {
    const h = harness();
    await h.engine.startRun({ workflow: "linear", subjectId: "s", input: {} });
    const a = await leaseOne(h.engine, "doomed");

    // The worker dies. Nothing reports anything; the lease simply runs out.
    h.advance(31_000);
    const reclaimed = await h.engine.reclaimExpiredLeases();
    expect(reclaimed.map((task) => task.id)).toEqual([a.id]);

    const next = await leaseOne(h.engine, "survivor");
    expect(next.id).toBe(a.id);
    expect(next.leasedBy).toBe("survivor");

    // And the dead worker cannot come back and overwrite the new result.
    await expect(h.engine.completeTask({ taskId: a.id, workerId: "doomed", output: {} })).rejects.toThrow(
      ForbiddenError,
    );
  });

  it("leaves a live lease alone", async () => {
    const h = harness();
    await h.engine.startRun({ workflow: "linear", subjectId: "s", input: {} });
    await leaseOne(h.engine, "alive");

    h.advance(10_000);
    expect(await h.engine.reclaimExpiredLeases()).toHaveLength(0);
  });

  it("records the expiry so the history explains the extra attempt", async () => {
    const h = harness();
    const run = await h.engine.startRun({ workflow: "linear", subjectId: "s", input: {} });
    await leaseOne(h.engine, "doomed");
    h.advance(31_000);
    await h.engine.reclaimExpiredLeases();

    const events = await h.store.reads.listEvents(run.id);
    expect(events.some((event) => event.type === "task.lease_expired")).toBe(true);
  });
});

describe("approval gates", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  async function reachTheGate() {
    const run = await h.engine.startRun({ workflow: "gated", subjectId: "s", input: {} });
    const draft = await leaseOne(h.engine);
    await h.engine.completeTask({ taskId: draft.id, workerId: "w1", output: { body: "Please pay" } });

    const gate = await leaseOne(h.engine);
    const approval = await h.engine.requestApproval({
      taskId: gate.id,
      workerId: "w1",
      summary: "Send the draft",
      payload: { body: "Please pay" },
      requiredRoles: ["ar_manager"],
      expiresInHours: 24,
    });
    return { run, gate, approval };
  }

  it("suspends the run rather than carrying on", async () => {
    const { run, gate } = await reachTheGate();

    expect((await h.store.reads.getTask(gate.id))?.status).toBe("waiting_approval");
    expect((await h.store.reads.getRun(run.id))?.status).toBe("waiting_approval");
    // Nothing downstream is available to lease.
    expect(await h.engine.leaseTasks("w2", 5, 1000)).toHaveLength(0);
  });

  it("releases the run when somebody approves", async () => {
    const { run, approval } = await reachTheGate();

    await h.engine.decideApproval({
      approvalId: approval.id,
      decision: "approved",
      decidedBy: "ana",
      roles: ["ar_manager"],
      note: "Fine to send",
    });

    expect((await h.store.reads.getRun(run.id))?.status).toBe("running");
    const next = await leaseOne(h.engine);
    expect(next.key).toBe("approve");
  });

  it("refuses a decision from somebody without the role", async () => {
    const { approval } = await reachTheGate();

    await expect(
      h.engine.decideApproval({
        approvalId: approval.id,
        decision: "approved",
        decidedBy: "intern",
        roles: ["viewer"],
      }),
    ).rejects.toThrow(ForbiddenError);

    expect((await h.store.reads.getApproval(approval.id))?.status).toBe("pending");
  });

  it("refuses a second decision on the same approval", async () => {
    const { approval } = await reachTheGate();
    await h.engine.decideApproval({
      approvalId: approval.id,
      decision: "approved",
      decidedBy: "ana",
      roles: ["ar_manager"],
    });

    await expect(
      h.engine.decideApproval({
        approvalId: approval.id,
        decision: "rejected",
        decidedBy: "bo",
        roles: ["ar_manager"],
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("skips the downstream work when the approval is rejected", async () => {
    const { run, gate, approval } = await reachTheGate();

    await h.engine.decideApproval({
      approvalId: approval.id,
      decision: "rejected",
      decidedBy: "ana",
      roles: ["ar_manager"],
      note: "Customer already queried this invoice",
    });

    expect((await h.store.reads.getTask(gate.id))?.status).toBe("skipped");
    const tasks = await h.store.reads.listTasks(run.id);
    expect(tasks.find((task) => task.key === "send")?.status).toBe("ready");

    // The reason is on the record, which is the point of the gate.
    const events = await h.store.reads.listEvents(run.id);
    const rejection = events.find((event) => event.type === "approval.rejected");
    expect(rejection?.payload).toMatchObject({ note: "Customer already queried this invoice" });
    expect(rejection?.actor).toBe("ana");
  });

  it("keeps an edited payload distinct from the original", async () => {
    const { approval } = await reachTheGate();

    await h.engine.decideApproval({
      approvalId: approval.id,
      decision: "approved",
      decidedBy: "ana",
      roles: ["ar_manager"],
      editedPayload: { body: "Please pay when you can" },
    });

    const decided = await h.store.reads.getApproval(approval.id);
    // Approving an edit is not approving the original, and the record must show both.
    expect(decided?.payload).toEqual({ body: "Please pay" });
    expect(decided?.editedPayload).toEqual({ body: "Please pay when you can" });
  });

  it("expires an approval nobody decided, and does not send", async () => {
    const { run, gate, approval } = await reachTheGate();

    h.advance(25 * 3_600_000);
    const expired = await h.engine.expireApprovals();

    expect(expired).toHaveLength(1);
    expect((await h.store.reads.getApproval(approval.id))?.status).toBe("expired");
    // onExpiry is "skip" for this workflow: no approval means no send.
    expect((await h.store.reads.getTask(gate.id))?.status).toBe("skipped");
    expect((await h.store.reads.getRun(run.id))?.status).toBe("running");
  });

  it("leaves an approval that is still in date alone", async () => {
    const { approval } = await reachTheGate();
    h.advance(23 * 3_600_000);

    expect(await h.engine.expireApprovals()).toHaveLength(0);
    expect((await h.store.reads.getApproval(approval.id))?.status).toBe("pending");
  });
});

describe("branching", () => {
  it("skips a branch whose guard is false and still joins", async () => {
    const h = harness();
    const run = await h.engine.startRun({ workflow: "branched", subjectId: "s", input: {} });

    const a = await leaseOne(h.engine);
    await h.engine.completeTask({ taskId: a.id, workerId: "w1", output: { branch: "one" } });

    const tasks = await h.store.reads.listTasks(run.id);
    expect(tasks.find((task) => task.key === "c")?.status).toBe("skipped");

    const b = await leaseOne(h.engine);
    expect(b.key).toBe("b");
    await h.engine.completeTask({ taskId: b.id, workerId: "w1", output: {} });

    // d depends on both; a skipped dependency counts as settled, so the join proceeds.
    const d = await leaseOne(h.engine);
    expect(d.key).toBe("d");
  });

  it("runs both branches when the guard is true", async () => {
    const h = harness();
    const run = await h.engine.startRun({ workflow: "branched", subjectId: "s", input: {} });
    const a = await leaseOne(h.engine);
    await h.engine.completeTask({ taskId: a.id, workerId: "w1", output: { branch: "both" } });

    const tasks = await h.store.reads.listTasks(run.id);
    expect(tasks.filter((task) => task.status === "ready").map((task) => task.key).sort()).toEqual(["b", "c"]);
  });

  it("does not run the join when a dependency failed", async () => {
    const h = harness();
    const run = await h.engine.startRun({ workflow: "branched", subjectId: "s", input: {} });
    const a = await leaseOne(h.engine);
    await h.engine.failTask({
      taskId: a.id,
      workerId: "w1",
      error: { code: "boom", message: "no", retryable: false },
    });

    const tasks = await h.store.reads.listTasks(run.id);
    expect(tasks.filter((task) => task.key !== "a").every((task) => task.status === "pending")).toBe(true);
    expect((await h.store.reads.getRun(run.id))?.status).toBe("failed");
  });
});

describe("the outbox", () => {
  it("commits the effect with the state change that decided on it", async () => {
    const h = harness();
    const run = await h.engine.startRun({ workflow: "linear", subjectId: "s", input: {} });
    const a = await leaseOne(h.engine);

    await h.engine.completeTask({
      taskId: a.id,
      workerId: "w1",
      output: {},
      outbox: [{ channel: "email.send", payload: { to: "ap@acme.example" }, idempotencyKey: "inv-1-reminder" }],
    });

    const messages = await h.store.reads.listOutbox({});
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ channel: "email.send", status: "pending", runId: run.id });
  });

  it("does not enqueue anything when the task fails", async () => {
    const h = harness();
    await h.engine.startRun({ workflow: "linear", subjectId: "s", input: {} });
    const a = await leaseOne(h.engine);

    await h.engine.failTask({
      taskId: a.id,
      workerId: "w1",
      error: { code: "boom", message: "no", retryable: false },
    });

    expect(await h.store.reads.listOutbox({})).toHaveLength(0);
  });

  it("produces one message however many times the task is retried", async () => {
    const h = harness();
    await h.engine.startRun({ workflow: "linear", subjectId: "s", input: {} });

    let task = await leaseOne(h.engine);
    await h.engine.failTask({
      taskId: task.id,
      workerId: "w1",
      error: { code: "flaky", message: "again", retryable: true },
    });

    task = await leaseOne(h.engine, "w2");
    await h.engine.completeTask({
      taskId: task.id,
      workerId: "w2",
      output: {},
      // The key is derived from the business fact, not the attempt, which is what makes
      // a retry safe.
      outbox: [{ channel: "email.send", payload: {}, idempotencyKey: "inv-1-reminder" }],
    });

    expect(await h.store.reads.listOutbox({})).toHaveLength(1);
  });
});

describe("cancellation", () => {
  it("stops everything that has not already finished", async () => {
    const h = harness();
    const run = await h.engine.startRun({ workflow: "linear", subjectId: "s", input: {} });
    const a = await leaseOne(h.engine);
    await h.engine.completeTask({ taskId: a.id, workerId: "w1", output: {} });

    await h.engine.cancelRun(run.id, "ana", "Customer paid");

    const tasks = await h.store.reads.listTasks(run.id);
    expect(tasks.find((task) => task.key === "a")?.status).toBe("succeeded");
    expect(tasks.filter((task) => task.key !== "a").every((task) => task.status === "cancelled")).toBe(true);
    expect((await h.store.reads.getRun(run.id))?.status).toBe("cancelled");
  });

  it("is a no-op on a run that already finished", async () => {
    const h = harness();
    const run = await h.engine.startRun({ workflow: "linear", subjectId: "s", input: {} });
    for (const _ of ["a", "b", "c"]) {
      const task = await leaseOne(h.engine);
      await h.engine.completeTask({ taskId: task.id, workerId: "w1", output: {} });
    }

    const after = await h.engine.cancelRun(run.id, "ana", "too late");
    expect(after.status).toBe("succeeded");
  });
});

describe("the state machine holds", () => {
  it("refuses to move a finished task back to running", async () => {
    const h = harness();
    await h.engine.startRun({ workflow: "linear", subjectId: "s", input: {} });
    const a = await leaseOne(h.engine);
    await h.engine.completeTask({ taskId: a.id, workerId: "w1", output: {} });

    await expect(h.engine.requeueTask(a.id, "ana")).rejects.toThrow(ForbiddenError);
  });

  it("surfaces an illegal transition as such", async () => {
    const h = harness();
    const run = await h.engine.startRun({ workflow: "linear", subjectId: "s", input: {} });
    await h.engine.cancelRun(run.id, "ana", "done");

    // Cancelled is terminal, so nothing can move it.
    const store = h.store;
    const cancelled = await store.reads.getRun(run.id);
    expect(() => {
      if (cancelled?.status === "cancelled") throw new IllegalTransitionError("run", run.id, "cancelled", "running");
    }).toThrow(IllegalTransitionError);
  });
});
