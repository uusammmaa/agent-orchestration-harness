import {
  assertRunTransition,
  assertTaskTransition,
  deriveRunStatus,
  isRunTerminal,
} from "../domain/state-machine";
import type {
  Approval,
  Event,
  Run,
  Task,
  WorkflowContext,
  WorkflowDefinition,
} from "../domain/types";
import type { Store, StoreTx } from "../store/port";
import { NotFoundError } from "../store/port";

/**
 * The engine.
 *
 * Everything that mutates a run goes through here, and every mutation obeys three rules:
 *
 *  1. **Legal transitions only.** Checked against the state machine before the write.
 *  2. **One transaction per decision.** The state change, the event that records it and
 *     any outbox message it implies all commit together or not at all.
 *  3. **Every change leaves a trace.** No state moves without an event explaining why.
 *
 * The engine does not execute tasks. Workers lease them and call back with the result,
 * which is what lets a task be an LLM agent, an ERP write or a human decision without the
 * engine knowing the difference.
 */

export interface EngineOptions {
  store: Store;
  workflows: WorkflowDefinition[];
  now?: () => Date;
  idFactory?: (prefix: string) => string;
  /** Backoff for retryable failures. Injected so tests are not sleeps. */
  backoff?: (attempt: number) => number;
}

export interface StartRunInput {
  workflow: string;
  subjectId: string;
  input: Record<string, unknown>;
  idempotencyKey?: string;
  labels?: Record<string, string>;
  actor?: string;
}

export interface CompleteTaskInput {
  taskId: string;
  workerId: string;
  output: Record<string, unknown>;
  /** Effects to deliver after the state change commits. */
  outbox?: Array<{ channel: string; payload: Record<string, unknown>; idempotencyKey: string }>;
}

export interface FailTaskInput {
  taskId: string;
  workerId: string;
  error: { code: string; message: string; retryable: boolean };
}

export interface DecideApprovalInput {
  approvalId: string;
  decision: "approved" | "rejected";
  decidedBy: string;
  roles: string[];
  note?: string;
  /** Present when the approver changed what they are approving. */
  editedPayload?: Record<string, unknown>;
}

export class WorkflowNotFoundError extends Error {
  constructor(name: string) {
    super(`No workflow registered under "${name}"`);
    this.name = "WorkflowNotFoundError";
  }
}

export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenError";
  }
}

/** Exponential with full jitter: spreads a thundering herd instead of synchronising it. */
export function defaultBackoff(attempt: number): number {
  const ceiling = Math.min(30 * 60_000, 2_000 * 2 ** (attempt - 1));
  return Math.floor(Math.random() * ceiling);
}

export class Engine {
  private readonly workflows = new Map<string, WorkflowDefinition>();
  private readonly now: () => Date;
  private readonly newId: (prefix: string) => string;
  private readonly backoff: (attempt: number) => number;
  private counter = 0;

  constructor(private readonly options: EngineOptions) {
    for (const workflow of options.workflows) this.workflows.set(workflow.name, workflow);
    this.now = options.now ?? (() => new Date());
    this.backoff = options.backoff ?? defaultBackoff;
    this.newId =
      options.idFactory ?? ((prefix: string) => `${prefix}_${(++this.counter).toString(36).padStart(8, "0")}`);
  }

  get store(): Store {
    return this.options.store;
  }

  getWorkflow(name: string): WorkflowDefinition {
    const workflow = this.workflows.get(name);
    if (!workflow) throw new WorkflowNotFoundError(name);
    return workflow;
  }

  listWorkflows(): WorkflowDefinition[] {
    return [...this.workflows.values()];
  }

  /* ------------------------------------------------------------------ start -- */

  /**
   * Create a run and its tasks.
   *
   * Idempotent on `idempotencyKey`: calling twice with the same key returns the first
   * run rather than creating a second. That matters because the callers are webhooks and
   * cron jobs, both of which retry.
   */
  async startRun(input: StartRunInput): Promise<Run> {
    const workflow = this.getWorkflow(input.workflow);
    const actor = input.actor ?? "system";

    return this.options.store.transaction(async (tx) => {
      if (input.idempotencyKey) {
        const existing = await tx.getRunByIdempotencyKey(workflow.name, input.idempotencyKey);
        if (existing) return existing;
      }

      const now = this.now();
      const run: Run = {
        id: this.newId("run"),
        workflow: workflow.name,
        workflowVersion: workflow.version,
        status: "pending",
        subjectType: workflow.subjectType,
        subjectId: input.subjectId,
        input: input.input,
        context: {},
        idempotencyKey: input.idempotencyKey ?? null,
        version: 0,
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        finishedAt: null,
        error: null,
        labels: input.labels ?? {},
      };

      const inserted = await tx.insertRun(run);
      // insertRun is idempotent, so a concurrent caller may have won the race.
      if (inserted.id !== run.id) return inserted;

      const tasks = workflow.tasks.map<Task>((definition) => ({
        id: this.newId("tsk"),
        runId: run.id,
        key: definition.key,
        handler: definition.handler,
        /*
         * Everything starts pending, including tasks with no dependencies. `advance()` is
         * what promotes a task to ready, and promotion is also where its `input` is
         * resolved and its `when` guard is evaluated. Creating a root task as ready
         * directly would skip that step and hand the worker a task with an empty input.
         */
        status: "pending",
        dependsOn: definition.dependsOn ?? [],
        requires: definition.requires ?? [],
        input: {},
        output: null,
        attempt: 0,
        maxAttempts: definition.maxAttempts ?? 3,
        leasedBy: null,
        leaseExpiresAt: null,
        runAfter: null,
        approvalId: null,
        version: 0,
        createdAt: now,
        updatedAt: now,
        finishedAt: null,
        error: null,
      }));

      await tx.insertTasks(tasks);
      await this.emit(tx, run.id, null, "run.created", actor, {
        workflow: workflow.name,
        version: workflow.version,
        subjectId: input.subjectId,
      });
      for (const task of tasks) {
        await this.emit(tx, run.id, task.id, "task.created", actor, { key: task.key, handler: task.handler });
      }

      const started = await tx.updateRun(run.id, run.version, { status: "running", startedAt: now });
      await this.emit(tx, run.id, null, "run.started", actor, {});

      // Promotes the root tasks, resolving their inputs and guards on the way.
      await this.advance(tx, run.id, actor);
      return (await tx.getRun(started.id)) ?? started;
    });
  }

  /* ------------------------------------------------------------------ lease -- */

  async leaseTasks(workerId: string, limit: number, leaseMs: number, handlers?: string[]): Promise<Task[]> {
    return this.options.store.transaction(async (tx) => {
      const leased = await tx.leaseTasks({
        workerId,
        limit,
        leaseMs,
        now: this.now(),
        ...(handlers ? { handlers } : {}),
      });

      for (const task of leased) {
        await tx.insertAttempt({
          id: this.newId("att"),
          taskId: task.id,
          runId: task.runId,
          attempt: task.attempt,
          workerId,
          startedAt: this.now(),
          finishedAt: null,
          outcome: null,
          error: null,
          durationMs: null,
        });
        await this.emit(tx, task.runId, task.id, "task.leased", workerId, {
          attempt: task.attempt,
          leaseExpiresAt: task.leaseExpiresAt?.toISOString(),
        });
      }
      return leased;
    });
  }

  /**
   * Return tasks whose worker stopped heartbeating.
   *
   * Back to `ready`, not `failed`. The work may well have completed — the worker might
   * have died between doing it and reporting it — so the safe move is to run it again and
   * rely on handler idempotency, which is exactly why every handler is required to have it.
   */
  async reclaimExpiredLeases(limit = 50): Promise<Task[]> {
    return this.options.store.transaction(async (tx) => {
      const reclaimed = await tx.reclaimExpiredLeases(this.now(), limit);
      for (const task of reclaimed) {
        await this.emit(tx, task.runId, task.id, "task.lease_expired", "system", {
          attempt: task.attempt,
          previousWorker: task.leasedBy,
        });
      }
      return reclaimed;
    });
  }

  /* --------------------------------------------------------------- complete -- */

  async completeTask(input: CompleteTaskInput): Promise<Task> {
    return this.options.store.transaction(async (tx) => {
      const task = await this.requireTask(tx, input.taskId);
      this.assertLease(task, input.workerId);
      assertTaskTransition(task.id, task.status, "succeeded");

      const now = this.now();
      const updated = await tx.updateTask(task.id, task.version, {
        status: "succeeded",
        output: input.output,
        leasedBy: null,
        leaseExpiresAt: null,
        finishedAt: now,
        error: null,
      });

      await this.closeAttempt(tx, task, "succeeded", null);
      await this.emit(tx, task.runId, task.id, "task.succeeded", input.workerId, {
        key: task.key,
        attempt: task.attempt,
      });

      // The outbox write is in this transaction on purpose: the effect and the decision
      // to have the effect commit together, or neither does.
      for (const message of input.outbox ?? []) {
        const enqueued = await tx.enqueueOutbox({
          runId: task.runId,
          taskId: task.id,
          channel: message.channel,
          payload: message.payload,
          idempotencyKey: message.idempotencyKey,
          status: "pending",
          attempts: 0,
          maxAttempts: 5,
          nextAttemptAt: now,
        });
        await this.emit(tx, task.runId, task.id, "outbox.enqueued", input.workerId, {
          channel: enqueued.channel,
          outboxId: enqueued.id,
        });
      }

      await this.advance(tx, task.runId, input.workerId);
      return updated;
    });
  }

  async failTask(input: FailTaskInput): Promise<Task> {
    return this.options.store.transaction(async (tx) => {
      const task = await this.requireTask(tx, input.taskId);
      this.assertLease(task, input.workerId);

      const now = this.now();
      const error = { ...input.error, at: now.toISOString() };
      const attemptsLeft = task.attempt < task.maxAttempts;
      const willRetry = input.error.retryable && attemptsLeft;

      await this.closeAttempt(tx, task, "failed", error);

      if (willRetry) {
        const delay = this.backoff(task.attempt);
        assertTaskTransition(task.id, task.status, "ready");
        const updated = await tx.updateTask(task.id, task.version, {
          status: "ready",
          leasedBy: null,
          leaseExpiresAt: null,
          runAfter: new Date(now.getTime() + delay),
          error,
        });
        await this.emit(tx, task.runId, task.id, "task.retry_scheduled", input.workerId, {
          attempt: task.attempt,
          delayMs: delay,
          code: input.error.code,
        });
        return updated;
      }

      /*
       * Out of attempts, or the failure is not retryable. Quarantine rather than fail:
       * both stop the run, but quarantine says "a human must look at this" and keeps the
       * task requeueable once they have. A task that is merely `failed` invites somebody
       * to retry it blindly.
       */
      const terminal = input.error.retryable ? "quarantined" : "failed";
      assertTaskTransition(task.id, task.status, terminal);
      const updated = await tx.updateTask(task.id, task.version, {
        status: terminal,
        leasedBy: null,
        leaseExpiresAt: null,
        finishedAt: now,
        error,
      });

      await this.emit(
        tx,
        task.runId,
        task.id,
        terminal === "quarantined" ? "task.quarantined" : "task.failed",
        input.workerId,
        { attempt: task.attempt, code: input.error.code, message: input.error.message },
      );

      await this.advance(tx, task.runId, input.workerId);
      return updated;
    });
  }

  /* -------------------------------------------------------------- approvals -- */

  /**
   * Suspend a task pending a human decision.
   *
   * Called by a worker that has produced something needing sign-off — a dunning email, a
   * payment plan. The draft goes in the approval payload, and nothing leaves the building
   * until somebody says so.
   */
  async requestApproval(params: {
    taskId: string;
    workerId: string;
    summary: string;
    payload: Record<string, unknown>;
    requiredRoles: string[];
    expiresInHours: number;
  }): Promise<Approval> {
    return this.options.store.transaction(async (tx) => {
      const task = await this.requireTask(tx, params.taskId);
      this.assertLease(task, params.workerId);
      assertTaskTransition(task.id, task.status, "waiting_approval");

      const now = this.now();
      const approval: Approval = {
        id: this.newId("apr"),
        runId: task.runId,
        taskId: task.id,
        summary: params.summary,
        payload: params.payload,
        requiredRoles: params.requiredRoles,
        status: "pending",
        requestedAt: now,
        expiresAt: new Date(now.getTime() + params.expiresInHours * 3_600_000),
        decidedAt: null,
        decidedBy: null,
        decisionNote: null,
        editedPayload: null,
        version: 0,
      };

      const inserted = await tx.insertApproval(approval);
      await tx.updateTask(task.id, task.version, {
        status: "waiting_approval",
        approvalId: inserted.id,
        leasedBy: null,
        leaseExpiresAt: null,
      });
      await this.closeAttempt(tx, task, "succeeded", null);
      await this.emit(tx, task.runId, task.id, "approval.requested", params.workerId, {
        approvalId: inserted.id,
        summary: params.summary,
        expiresAt: inserted.expiresAt.toISOString(),
      });

      await this.advance(tx, task.runId, params.workerId);
      return inserted;
    });
  }

  async decideApproval(input: DecideApprovalInput): Promise<Approval> {
    return this.options.store.transaction(async (tx) => {
      const approval = await tx.getApproval(input.approvalId);
      if (!approval) throw new NotFoundError("approval", input.approvalId);
      if (approval.status !== "pending") {
        throw new ForbiddenError(`Approval ${approval.id} was already ${approval.status}`);
      }

      /*
       * Roles are checked now, not when the approval was created. Somebody's authority
       * can be revoked between a request going out and a decision coming back, and the
       * decision is the moment that matters.
       */
      const permitted = approval.requiredRoles.some((role) => input.roles.includes(role));
      if (!permitted) {
        throw new ForbiddenError(
          `Deciding this needs one of: ${approval.requiredRoles.join(", ")}. You have: ${input.roles.join(", ") || "none"}`,
        );
      }

      const now = this.now();
      const decided = await tx.updateApproval(approval.id, approval.version, {
        status: input.decision,
        decidedAt: now,
        decidedBy: input.decidedBy,
        decisionNote: input.note ?? null,
        editedPayload: input.editedPayload ?? null,
      });

      const task = await this.requireTask(tx, approval.taskId);

      if (input.decision === "approved") {
        // Back to ready so the next attempt carries the approved payload forward.
        assertTaskTransition(task.id, task.status, "ready");
        await tx.updateTask(task.id, task.version, { status: "ready", approvalId: approval.id, runAfter: null });
        await this.emit(tx, approval.runId, approval.taskId, "approval.approved", input.decidedBy, {
          approvalId: approval.id,
          note: input.note ?? null,
          edited: Boolean(input.editedPayload),
        });
      } else {
        assertTaskTransition(task.id, task.status, "skipped");
        await tx.updateTask(task.id, task.version, { status: "skipped", finishedAt: now });
        await this.emit(tx, approval.runId, approval.taskId, "approval.rejected", input.decidedBy, {
          approvalId: approval.id,
          note: input.note ?? null,
        });
      }

      await this.advance(tx, approval.runId, input.decidedBy);
      return decided;
    });
  }

  /** Sweep approvals nobody decided in time. */
  async expireApprovals(limit = 50): Promise<Approval[]> {
    return this.options.store.transaction(async (tx) => {
      const now = this.now();
      const expired = await tx.findExpiredApprovals(now, limit);
      const handled: Approval[] = [];

      for (const approval of expired) {
        const updated = await tx.updateApproval(approval.id, approval.version, {
          status: "expired",
          decidedAt: now,
          decidedBy: "system",
          decisionNote: "Nobody decided before the deadline",
        });

        const task = await tx.getTask(approval.taskId);
        if (task && task.status === "waiting_approval") {
          const workflow = await this.workflowForRun(tx, approval.runId);
          const definition = workflow?.tasks.find((candidate) => candidate.key === task.key);
          const onExpiry = definition?.approval?.onExpiry ?? "fail";

          if (onExpiry === "auto_approve") {
            await tx.updateTask(task.id, task.version, { status: "ready", runAfter: null });
          } else if (onExpiry === "skip") {
            await tx.updateTask(task.id, task.version, { status: "skipped", finishedAt: now });
          } else {
            await tx.updateTask(task.id, task.version, {
              status: "failed",
              finishedAt: now,
              error: {
                code: "approval.expired",
                message: "The approval expired before anyone decided",
                retryable: false,
                at: now.toISOString(),
              },
            });
          }
        }

        await this.emit(tx, approval.runId, approval.taskId, "approval.expired", "system", {
          approvalId: approval.id,
        });
        await this.advance(tx, approval.runId, "system");
        handled.push(updated);
      }
      return handled;
    });
  }

  /* ------------------------------------------------------------------ admin -- */

  async cancelRun(runId: string, actor: string, reason: string): Promise<Run> {
    return this.options.store.transaction(async (tx) => {
      const run = await tx.getRun(runId);
      if (!run) throw new NotFoundError("run", runId);
      if (isRunTerminal(run.status)) return run;

      assertRunTransition(run.id, run.status, "cancelled");
      const now = this.now();

      for (const task of await tx.listTasks(runId)) {
        if (task.status === "succeeded" || task.status === "skipped" || task.status === "cancelled") continue;
        await tx.updateTask(task.id, task.version, { status: "cancelled", finishedAt: now, leasedBy: null });
      }

      const cancelled = await tx.updateRun(run.id, run.version, {
        status: "cancelled",
        finishedAt: now,
        error: { code: "cancelled", message: reason, at: now.toISOString() },
      });
      await this.emit(tx, run.id, null, "run.cancelled", actor, { reason });
      return cancelled;
    });
  }

  /** Put a quarantined task back in the queue, once a human has dealt with the cause. */
  async requeueTask(taskId: string, actor: string): Promise<Task> {
    return this.options.store.transaction(async (tx) => {
      const task = await this.requireTask(tx, taskId);
      if (task.status !== "quarantined" && task.status !== "failed") {
        throw new ForbiddenError(`Only a failed or quarantined task can be requeued; this one is ${task.status}`);
      }

      const updated = await tx.updateTask(task.id, task.version, {
        status: "ready",
        attempt: 0,
        runAfter: null,
        error: null,
      });
      await this.emit(tx, task.runId, task.id, "task.ready", actor, { requeued: true });

      const run = await tx.getRun(task.runId);
      if (run && run.status === "failed") {
        await tx.updateRun(run.id, run.version, { status: "running", finishedAt: null, error: null });
      }
      return updated;
    });
  }

  /* -------------------------------------------------------------- internals -- */

  /**
   * Recompute what should happen next in a run.
   *
   * Called after every state change. It promotes tasks whose dependencies are satisfied,
   * applies `when` guards, resolves task inputs from earlier outputs, and derives the
   * run's own status from its tasks. Keeping this in one place is what stops "the run
   * says running but nothing is ready" bugs: there is exactly one function that decides.
   */
  private async advance(tx: StoreTx, runId: string, actor: string): Promise<void> {
    const run = await tx.getRun(runId);
    if (!run || isRunTerminal(run.status)) return;

    const workflow = this.workflows.get(run.workflow);
    if (!workflow) return;

    /*
     * Iterate to a fixed point.
     *
     * Skipping one task can settle the dependency of another, which can settle a third.
     * A single pass over a snapshot only ever resolves the first of those, and the run
     * then sits waiting for an advance() that will never be called — because nothing is
     * going to complete and trigger one. Re-reading and repeating until nothing changes
     * is what makes a cascade of skips resolve in one go.
     *
     * Bounded, because a bug that made this oscillate would otherwise hold a transaction
     * open forever. One pass per task is comfortably enough.
     */
    let changed = true;
    let passes = 0;
    const maxPasses = workflow.tasks.length + 2;

    while (changed && passes < maxPasses) {
      changed = false;
      passes++;
      changed = await this.promoteReadyTasks(tx, run, workflow, actor);
    }

    await this.settleRunStatus(tx, runId, actor);
  }

  /** One pass of the promotion loop. Returns true when it changed anything. */
  private async promoteReadyTasks(
    tx: StoreTx,
    run: Run,
    workflow: WorkflowDefinition,
    actor: string,
  ): Promise<boolean> {
    const runId = run.id;
    const tasks = await tx.listTasks(runId);
    const outputs = Object.fromEntries(
      tasks.filter((task) => task.status === "succeeded" && task.output).map((task) => [task.key, task.output!]),
    ) as Record<string, Record<string, unknown>>;

    const context: WorkflowContext = { runId, input: run.input, outputs, labels: run.labels };
    const byKey = new Map(tasks.map((task) => [task.key, task]));
    let changed = false;

    for (const task of tasks) {
      if (task.status !== "pending") continue;

      const definition = workflow.tasks.find((candidate) => candidate.key === task.key);
      if (!definition) continue;

      const upstream = [...task.dependsOn, ...task.requires].map((key) => byKey.get(key));

      // A skipped dependency counts as settled: the run carries on without that branch
      // rather than hanging on something that will never arrive.
      const settled = upstream.every(
        (dependency) => dependency && (dependency.status === "succeeded" || dependency.status === "skipped"),
      );
      if (!settled) continue;

      // A failed or quarantined dependency leaves this task pending. The run is already
      // failing; skipping here would hide which branch actually stopped.
      const brokenUpstream = upstream.some(
        (dependency) =>
          dependency &&
          (dependency.status === "failed" ||
            dependency.status === "quarantined" ||
            dependency.status === "cancelled"),
      );
      if (brokenUpstream) continue;

      // A requirement that did not succeed skips this task. This is what stops a
      // rejected or expired approval from being followed by the send it was gating.
      const unmetRequirement = task.requires
        .map((key) => byKey.get(key))
        .find((dependency) => dependency && dependency.status !== "succeeded");

      if (unmetRequirement) {
        await tx.updateTask(task.id, task.version, { status: "skipped", finishedAt: this.now() });
        await this.emit(tx, runId, task.id, "task.skipped", actor, {
          key: task.key,
          reason: `${unmetRequirement.key} did not succeed`,
        });
        changed = true;
        continue;
      }

      if (definition.when && !definition.when(context)) {
        await tx.updateTask(task.id, task.version, { status: "skipped", finishedAt: this.now() });
        await this.emit(tx, runId, task.id, "task.skipped", actor, { key: task.key, reason: "guard returned false" });
        changed = true;
        continue;
      }

      const input: Record<string, unknown> = definition.input ? definition.input(context) : {};

      /*
       * An approval gate's wording, roles and expiry are declared on the workflow, not in
       * the handler. Resolving them here means the policy lives with the process it
       * belongs to, and the handler stays generic.
       */
      if (definition.approval) {
        input.summary = definition.approval.summary(context);
        input.requiredRoles = definition.approval.requiredRoles;
        input.expiresInHours = definition.approval.expiresInHours;
        const source = task.dependsOn[task.dependsOn.length - 1];
        input.draft = source ? (context.outputs[source] ?? {}) : {};
      }

      await tx.updateTask(task.id, task.version, { status: "ready", ...(Object.keys(input).length ? { input } : {}) });
      await this.emit(tx, runId, task.id, "task.ready", actor, { key: task.key });
      changed = true;
    }

    return changed;
  }

  /** Derive the run's status from its tasks, and record the transition if it moved. */
  private async settleRunStatus(tx: StoreTx, runId: string, actor: string): Promise<void> {
    const run = await tx.getRun(runId);
    if (!run || isRunTerminal(run.status)) return;

    const tasks = await tx.listTasks(runId);
    const derived = deriveRunStatus(
      tasks.map((task) => task.status),
      run.status,
    );

    if (derived !== run.status) {
      const current = await tx.getRun(runId);
      if (!current) return;
      assertRunTransition(runId, current.status, derived);

      const now = this.now();
      const finished = isRunTerminal(derived);
      const failedTask = tasks.find((task) => task.status === "quarantined" || task.status === "failed");

      await tx.updateRun(runId, current.version, {
        status: derived,
        ...(finished ? { finishedAt: now } : {}),
        ...(derived === "failed" && failedTask
          ? {
              error: {
                code: failedTask.error?.code ?? "task_failed",
                message: failedTask.error?.message ?? `Task ${failedTask.key} did not complete`,
                taskId: failedTask.id,
                at: now.toISOString(),
              },
            }
          : {}),
        // Carry task outputs into the run context so callers get one place to read.
        context: Object.fromEntries(
          tasks.filter((task) => task.output).map((task) => [task.key, task.output as Record<string, unknown>]),
        ),
      });

      if (derived === "succeeded") await this.emit(tx, runId, null, "run.succeeded", actor, {});
      if (derived === "failed") {
        await this.emit(tx, runId, null, "run.failed", actor, { taskKey: failedTask?.key });
      }
    }
  }

  private async workflowForRun(tx: StoreTx, runId: string): Promise<WorkflowDefinition | undefined> {
    const run = await tx.getRun(runId);
    return run ? this.workflows.get(run.workflow) : undefined;
  }

  private async requireTask(tx: StoreTx, taskId: string): Promise<Task> {
    const task = await tx.getTask(taskId);
    if (!task) throw new NotFoundError("task", taskId);
    return task;
  }

  /**
   * A worker may only report on a task it still holds.
   *
   * Without this, a worker whose lease expired and whose task was reclaimed and re-run by
   * somebody else could come back minutes later and overwrite the newer result.
   */
  private assertLease(task: Task, workerId: string): void {
    if (task.status !== "leased" || task.leasedBy !== workerId) {
      throw new ForbiddenError(
        `Worker ${workerId} does not hold the lease on task ${task.id} (status ${task.status}, held by ${task.leasedBy ?? "nobody"})`,
      );
    }
  }

  private async closeAttempt(
    tx: StoreTx,
    task: Task,
    outcome: "succeeded" | "failed",
    error: Task["error"],
  ): Promise<void> {
    const attempts = await tx.listAttempts(task.id);
    const open = attempts.find((attempt) => attempt.attempt === task.attempt && attempt.finishedAt === null);
    if (!open) return;

    const now = this.now();
    await tx.finishAttempt(open.id, {
      finishedAt: now,
      outcome,
      error,
      durationMs: now.getTime() - open.startedAt.getTime(),
    });
  }

  private async emit(
    tx: StoreTx,
    runId: string,
    taskId: string | null,
    type: Event["type"],
    actor: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await tx.appendEvent({ runId, taskId, type, actor, payload, at: this.now() });
  }
}
