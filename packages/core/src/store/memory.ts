import type {
  Approval,
  Event,
  OutboxMessage,
  Run,
  Task,
  TaskAttempt,
} from "../domain/types";
import { isRunTerminal } from "../domain/state-machine";
import {
  NotFoundError,
  VersionConflictError,
  type ApprovalFilter,
  type ApprovalPatch,
  type HarnessStats,
  type LeaseParams,
  type OutboxPatch,
  type Page,
  type RunFilter,
  type RunPatch,
  type Store,
  type StoreTx,
  type TaskPatch,
} from "./port";

/**
 * In-memory store.
 *
 * Not a mock. It implements the same contract as the Postgres store and passes the same
 * contract test suite, which is what makes it safe to run the hosted console on and what
 * makes the engine tests fast enough to be worth running constantly.
 *
 * Transactions are real: the tx buffers its writes and applies them on commit. If the
 * unit of work throws, nothing lands. Without that, a test could pass here and the same
 * code lose half a transaction in Postgres.
 */

interface State {
  runs: Map<string, Run>;
  tasks: Map<string, Task>;
  attempts: Map<string, TaskAttempt>;
  approvals: Map<string, Approval>;
  events: Event[];
  outbox: Map<string, OutboxMessage>;
  sequenceByRun: Map<string, number>;
  counter: number;
}

function emptyState(): State {
  return {
    runs: new Map(),
    tasks: new Map(),
    attempts: new Map(),
    approvals: new Map(),
    events: [],
    outbox: new Map(),
    sequenceByRun: new Map(),
    counter: 0,
  };
}

function cloneState(state: State): State {
  return {
    runs: new Map([...state.runs].map(([k, v]) => [k, structuredClone(v)])),
    tasks: new Map([...state.tasks].map(([k, v]) => [k, structuredClone(v)])),
    attempts: new Map([...state.attempts].map(([k, v]) => [k, structuredClone(v)])),
    approvals: new Map([...state.approvals].map(([k, v]) => [k, structuredClone(v)])),
    events: state.events.map((event) => structuredClone(event)),
    outbox: new Map([...state.outbox].map(([k, v]) => [k, structuredClone(v)])),
    sequenceByRun: new Map(state.sequenceByRun),
    counter: state.counter,
  };
}

export class MemoryStore implements Store {
  private state = emptyState();
  /** Serialises transactions, the way a single connection would. */
  private queue: Promise<unknown> = Promise.resolve();
  private depth = 0;
  private active: Tx | null = null;

  constructor(private readonly idPrefix = "m") {}

  get reads(): StoreTx {
    // Reads outside a transaction see committed state.
    return new Tx(this.state, () => undefined, this.idPrefix);
  }

  async transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    // A nested call joins the outer transaction rather than opening a second one.
    if (this.depth > 0 && this.active) return fn(this.active);

    const run = async (): Promise<T> => {
      const working = cloneState(this.state);
      const tx = new Tx(working, () => undefined, this.idPrefix);
      this.depth++;
      this.active = tx;
      try {
        const result = await fn(tx);
        this.state = working;
        return result;
      } finally {
        this.depth--;
        this.active = null;
      }
    };

    const chained = this.queue.then(run, run);
    // Keep the chain alive even when a transaction rejects.
    this.queue = chained.then(
      () => undefined,
      () => undefined,
    );
    return chained;
  }

  async close(): Promise<void> {
    this.state = emptyState();
  }

  /** Test and demo helper: load a prepared state. */
  seed(seed: { runs?: Run[]; tasks?: Task[]; approvals?: Approval[]; events?: Event[] }): void {
    for (const run of seed.runs ?? []) this.state.runs.set(run.id, structuredClone(run));
    for (const task of seed.tasks ?? []) this.state.tasks.set(task.id, structuredClone(task));
    for (const approval of seed.approvals ?? []) this.state.approvals.set(approval.id, structuredClone(approval));
    for (const event of seed.events ?? []) {
      this.state.events.push(structuredClone(event));
      this.state.sequenceByRun.set(event.runId, Math.max(this.state.sequenceByRun.get(event.runId) ?? 0, event.sequence));
    }
  }
}

class Tx implements StoreTx {
  constructor(
    private readonly state: State,
    private readonly _noop: () => void,
    private readonly idPrefix: string,
  ) {}

  private nextId(kind: string): string {
    this.state.counter += 1;
    return `${kind}_${this.idPrefix}${String(this.state.counter).padStart(6, "0")}`;
  }

  /* ------------------------------------------------------------------ reads -- */

  async getRun(id: string): Promise<Run | null> {
    const run = this.state.runs.get(id);
    return run ? structuredClone(run) : null;
  }

  async getRunByIdempotencyKey(workflow: string, key: string): Promise<Run | null> {
    for (const run of this.state.runs.values()) {
      if (run.workflow === workflow && run.idempotencyKey === key) return structuredClone(run);
    }
    return null;
  }

  async listRuns(filter: RunFilter): Promise<Page<Run>> {
    let items = [...this.state.runs.values()];
    if (filter.status?.length) items = items.filter((run) => filter.status!.includes(run.status));
    if (filter.workflow) items = items.filter((run) => run.workflow === filter.workflow);
    if (filter.subjectId) items = items.filter((run) => run.subjectId === filter.subjectId);
    if (filter.label) items = items.filter((run) => run.labels[filter.label!.key] === filter.label!.value);

    // Newest first, tie-broken by id so paging is stable.
    items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
    return paginate(items, filter.limit ?? 50, filter.cursor, (run) => run.id);
  }

  async getTask(id: string): Promise<Task | null> {
    const task = this.state.tasks.get(id);
    return task ? structuredClone(task) : null;
  }

  async listTasks(runId: string): Promise<Task[]> {
    return [...this.state.tasks.values()]
      .filter((task) => task.runId === runId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
      .map((task) => structuredClone(task));
  }

  async listAttempts(taskId: string): Promise<TaskAttempt[]> {
    return [...this.state.attempts.values()]
      .filter((attempt) => attempt.taskId === taskId)
      .sort((a, b) => a.attempt - b.attempt)
      .map((attempt) => structuredClone(attempt));
  }

  async getApproval(id: string): Promise<Approval | null> {
    const approval = this.state.approvals.get(id);
    return approval ? structuredClone(approval) : null;
  }

  async listApprovals(filter: ApprovalFilter): Promise<Page<Approval>> {
    let items = [...this.state.approvals.values()];
    if (filter.status?.length) items = items.filter((approval) => filter.status!.includes(approval.status));
    if (filter.runId) items = items.filter((approval) => approval.runId === filter.runId);
    items.sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime() || a.id.localeCompare(b.id));
    return paginate(items, filter.limit ?? 50, filter.cursor, (approval) => approval.id);
  }

  async listEvents(runId: string, afterSequence = 0): Promise<Event[]> {
    return this.state.events
      .filter((event) => event.runId === runId && event.sequence > afterSequence)
      .sort((a, b) => a.sequence - b.sequence)
      .map((event) => structuredClone(event));
  }

  async listOutbox(filter: { status?: OutboxMessage["status"]; limit?: number }): Promise<OutboxMessage[]> {
    return [...this.state.outbox.values()]
      .filter((message) => !filter.status || message.status === filter.status)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, filter.limit ?? 100)
      .map((message) => structuredClone(message));
  }

  async stats(): Promise<HarnessStats> {
    const runsByStatus: Record<string, number> = {};
    for (const run of this.state.runs.values()) {
      runsByStatus[run.status] = (runsByStatus[run.status] ?? 0) + 1;
    }
    const tasksByStatus: Record<string, number> = {};
    for (const task of this.state.tasks.values()) {
      tasksByStatus[task.status] = (tasksByStatus[task.status] ?? 0) + 1;
    }
    const outbox = [...this.state.outbox.values()];
    return {
      runsByStatus,
      tasksByStatus,
      pendingApprovals: [...this.state.approvals.values()].filter((a) => a.status === "pending").length,
      outboxPending: outbox.filter((m) => m.status === "pending").length,
      outboxFailed: outbox.filter((m) => m.status === "failed" || m.status === "abandoned").length,
      quarantinedTasks: tasksByStatus.quarantined ?? 0,
    };
  }

  /* ----------------------------------------------------------------- writes -- */

  async insertRun(run: Run): Promise<Run> {
    // Idempotency is a uniqueness constraint in Postgres; enforce the same thing here so
    // the contract tests are meaningful against both.
    if (run.idempotencyKey) {
      const existing = await this.getRunByIdempotencyKey(run.workflow, run.idempotencyKey);
      if (existing) return existing;
    }
    assertRunInvariants(run);
    const stored = structuredClone(run);
    this.state.runs.set(stored.id, stored);
    return structuredClone(stored);
  }

  async updateRun(id: string, expectedVersion: number, patch: RunPatch): Promise<Run> {
    const run = this.state.runs.get(id);
    if (!run) throw new NotFoundError("run", id);
    if (run.version !== expectedVersion) throw new VersionConflictError("run", id, expectedVersion, run.version);

    Object.assign(run, patch, { version: run.version + 1, updatedAt: new Date() });
    assertRunInvariants(run);
    return structuredClone(run);
  }

  async insertTasks(tasks: Task[]): Promise<Task[]> {
    for (const task of tasks) {
      assertTaskInvariants(task, this.state.tasks.values());
      this.state.tasks.set(task.id, structuredClone(task));
    }
    return tasks.map((task) => structuredClone(task));
  }

  async updateTask(id: string, expectedVersion: number, patch: TaskPatch): Promise<Task> {
    const task = this.state.tasks.get(id);
    if (!task) throw new NotFoundError("task", id);
    if (task.version !== expectedVersion) throw new VersionConflictError("task", id, expectedVersion, task.version);

    Object.assign(task, patch, { version: task.version + 1, updatedAt: new Date() });
    assertTaskInvariants(task, this.state.tasks.values());
    return structuredClone(task);
  }

  async leaseTasks(params: LeaseParams): Promise<Task[]> {
    const candidates = [...this.state.tasks.values()]
      .filter((task) => task.status === "ready")
      .filter((task) => !task.runAfter || task.runAfter <= params.now)
      .filter((task) => !params.handlers?.length || params.handlers.includes(task.handler))
      // Oldest first, so a task cannot be starved by a steady arrival of new work.
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
      .slice(0, params.limit);

    const leased: Task[] = [];
    for (const task of candidates) {
      task.status = "leased";
      task.leasedBy = params.workerId;
      task.leaseExpiresAt = new Date(params.now.getTime() + params.leaseMs);
      task.attempt += 1;
      task.version += 1;
      task.updatedAt = params.now;
      leased.push(structuredClone(task));
    }
    return leased;
  }

  async reclaimExpiredLeases(now: Date, limit: number): Promise<Task[]> {
    const expired = [...this.state.tasks.values()]
      .filter((task) => task.status === "leased" && task.leaseExpiresAt !== null && task.leaseExpiresAt <= now)
      .slice(0, limit);

    const reclaimed: Task[] = [];
    for (const task of expired) {
      // Back to ready, not failed: the work may well have been done. The handler's
      // idempotency is what makes re-running it safe, and that is the handler's job.
      task.status = "ready";
      task.leasedBy = null;
      task.leaseExpiresAt = null;
      task.version += 1;
      task.updatedAt = now;
      reclaimed.push(structuredClone(task));
    }
    return reclaimed;
  }

  async insertAttempt(attempt: TaskAttempt): Promise<TaskAttempt> {
    const stored = structuredClone(attempt);
    this.state.attempts.set(stored.id, stored);
    return structuredClone(stored);
  }

  async finishAttempt(
    id: string,
    patch: Pick<TaskAttempt, "finishedAt" | "outcome" | "error" | "durationMs">,
  ): Promise<TaskAttempt> {
    const attempt = this.state.attempts.get(id);
    if (!attempt) throw new NotFoundError("attempt", id);
    Object.assign(attempt, patch);
    return structuredClone(attempt);
  }

  async insertApproval(approval: Approval): Promise<Approval> {
    assertApprovalInvariants(approval);
    const stored = structuredClone(approval);
    this.state.approvals.set(stored.id, stored);
    return structuredClone(stored);
  }

  async updateApproval(id: string, expectedVersion: number, patch: ApprovalPatch): Promise<Approval> {
    const approval = this.state.approvals.get(id);
    if (!approval) throw new NotFoundError("approval", id);
    if (approval.version !== expectedVersion) {
      throw new VersionConflictError("approval", id, expectedVersion, approval.version);
    }
    Object.assign(approval, patch, { version: approval.version + 1 });
    assertApprovalInvariants(approval);
    return structuredClone(approval);
  }

  async findExpiredApprovals(now: Date, limit: number): Promise<Approval[]> {
    return [...this.state.approvals.values()]
      .filter((approval) => approval.status === "pending" && approval.expiresAt <= now)
      .slice(0, limit)
      .map((approval) => structuredClone(approval));
  }

  async appendEvent(event: Omit<Event, "id" | "sequence" | "at"> & { at?: Date }): Promise<Event> {
    const sequence = (this.state.sequenceByRun.get(event.runId) ?? 0) + 1;
    this.state.sequenceByRun.set(event.runId, sequence);

    const stored: Event = {
      ...event,
      id: this.nextId("evt"),
      sequence,
      at: event.at ?? new Date(),
    };
    this.state.events.push(structuredClone(stored));
    return structuredClone(stored);
  }

  async enqueueOutbox(
    message: Omit<OutboxMessage, "id" | "createdAt" | "deliveredAt" | "lastError">,
  ): Promise<OutboxMessage> {
    // The idempotency key is unique in Postgres; honour that here too.
    for (const existing of this.state.outbox.values()) {
      if (existing.idempotencyKey === message.idempotencyKey) return structuredClone(existing);
    }
    const stored: OutboxMessage = {
      ...message,
      id: this.nextId("obx"),
      createdAt: new Date(),
      deliveredAt: null,
      lastError: null,
    };
    this.state.outbox.set(stored.id, stored);
    return structuredClone(stored);
  }

  async claimOutbox(now: Date, limit: number): Promise<OutboxMessage[]> {
    return [...this.state.outbox.values()]
      .filter((message) => message.status === "pending" && message.nextAttemptAt <= now)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit)
      .map((message) => structuredClone(message));
  }

  async markOutbox(id: string, patch: OutboxPatch): Promise<OutboxMessage> {
    const message = this.state.outbox.get(id);
    if (!message) throw new NotFoundError("outbox", id);
    Object.assign(message, patch);
    return structuredClone(message);
  }
}

/**
 * The invariants the Postgres schema enforces with CHECK constraints.
 *
 * Duplicated here on purpose. Without them the in-memory store is strictly more
 * permissive than the real one, and the contract suite stops being evidence that code
 * proved against memory will behave in Postgres — which is the entire reason the
 * in-memory store is allowed to exist.
 */
export class ConstraintViolationError extends Error {
  constructor(constraint: string, detail: string) {
    super(`${constraint}: ${detail}`);
    this.name = "ConstraintViolationError";
  }
}

function assertRunInvariants(run: Run): void {
  const finished = run.finishedAt !== null;
  if (isRunTerminal(run.status) !== finished) {
    throw new ConstraintViolationError(
      "runs_finished_consistent",
      `run ${run.id} is ${run.status} but finishedAt is ${finished ? "set" : "null"}`,
    );
  }
}

function assertTaskInvariants(task: Task, existing: Iterable<Task>): void {
  const leased = task.leasedBy !== null && task.leaseExpiresAt !== null;
  if ((task.status === "leased") !== leased) {
    throw new ConstraintViolationError(
      "tasks_lease_consistent",
      `task ${task.id} is ${task.status} but its lease fields are ${leased ? "set" : "unset"}`,
    );
  }
  for (const other of existing) {
    if (other.id !== task.id && other.runId === task.runId && other.key === task.key) {
      throw new ConstraintViolationError("tasks_key_uq", `run ${task.runId} already has a task keyed "${task.key}"`);
    }
  }
}

function assertApprovalInvariants(approval: Approval): void {
  if (approval.status !== "pending" && (!approval.decidedAt || !approval.decidedBy)) {
    throw new ConstraintViolationError(
      "approvals_decision_complete",
      `approval ${approval.id} is ${approval.status} with nobody recorded as deciding it`,
    );
  }
  if (approval.requiredRoles.length === 0) {
    throw new ConstraintViolationError("approvals_roles_present", `approval ${approval.id} has no required roles`);
  }
}

function paginate<T>(items: T[], limit: number, cursor: string | undefined, idOf: (item: T) => string): Page<T> {
  const start = cursor ? items.findIndex((item) => idOf(item) === cursor) + 1 : 0;
  const slice = items.slice(start, start + limit);
  const last = slice[slice.length - 1];
  const hasMore = start + limit < items.length;
  return { items: slice, nextCursor: hasMore && last ? idOf(last) : null };
}
