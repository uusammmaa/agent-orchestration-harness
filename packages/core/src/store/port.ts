import type {
  Approval,
  ApprovalStatus,
  Event,
  EventType,
  OutboxMessage,
  Run,
  RunStatus,
  Task,
  TaskAttempt,
  TaskStatus,
} from "../domain/types";

/**
 * The storage port.
 *
 * Two implementations — Postgres and in-memory — and one contract test suite that both
 * must pass. That is what makes the in-memory store trustworthy enough to run the hosted
 * console on: it is not a simplified mock, it is the same contract with a different
 * backing store, held to it by the same tests.
 *
 * Two things this interface deliberately makes the caller's problem:
 *
 *  - **Transactions are explicit.** `transaction()` hands you a unit of work. Anything
 *    that must be atomic — a state change and the outbox message it implies — happens
 *    inside one. Implicit transactions hide exactly the bug this system exists to avoid.
 *
 *  - **Writes take an expected version.** Optimistic concurrency, not locks. Two workers
 *    racing on the same task means one of them gets a `VersionConflictError` and retries
 *    with fresh state, which is correct and cheap. Pessimistic locking here would
 *    serialise the whole engine.
 */

export interface Store {
  /**
   * Run a unit of work atomically. Throwing rolls it back.
   *
   * Nested calls join the outer transaction rather than opening a new one, so a helper
   * that wants atomicity does not have to know whether its caller already has it.
   */
  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T>;

  /** Everything a read-only caller needs, outside a transaction. */
  readonly reads: StoreReads;

  close(): Promise<void>;
}

export interface StoreReads {
  getRun(id: string): Promise<Run | null>;
  getRunByIdempotencyKey(workflow: string, key: string): Promise<Run | null>;
  listRuns(filter: RunFilter): Promise<Page<Run>>;
  getTask(id: string): Promise<Task | null>;
  listTasks(runId: string): Promise<Task[]>;
  listAttempts(taskId: string): Promise<TaskAttempt[]>;
  getApproval(id: string): Promise<Approval | null>;
  listApprovals(filter: ApprovalFilter): Promise<Page<Approval>>;
  listEvents(runId: string, afterSequence?: number): Promise<Event[]>;
  listOutbox(filter: { status?: OutboxMessage["status"]; limit?: number }): Promise<OutboxMessage[]>;
  /** Counts for the console header, computed in one round trip. */
  stats(): Promise<HarnessStats>;
}

export interface StoreTx extends StoreReads {
  insertRun(run: Run): Promise<Run>;
  /**
   * @param expectedVersion the version the caller read. A mismatch throws
   * `VersionConflictError` rather than silently overwriting somebody else's write.
   */
  updateRun(id: string, expectedVersion: number, patch: RunPatch): Promise<Run>;

  insertTasks(tasks: Task[]): Promise<Task[]>;
  updateTask(id: string, expectedVersion: number, patch: TaskPatch): Promise<Task>;

  /**
   * Claim up to `limit` ready tasks for a worker.
   *
   * Postgres does this with `FOR UPDATE SKIP LOCKED`, which is the whole reason this
   * method exists on the port rather than being composed from a read and a write: the
   * atomicity is the feature, and it cannot be expressed as two calls.
   */
  leaseTasks(params: LeaseParams): Promise<Task[]>;

  /** Return tasks whose lease has expired to `ready`, so a crashed worker's work resumes. */
  reclaimExpiredLeases(now: Date, limit: number): Promise<Task[]>;

  insertAttempt(attempt: TaskAttempt): Promise<TaskAttempt>;
  finishAttempt(id: string, patch: Pick<TaskAttempt, "finishedAt" | "outcome" | "error" | "durationMs">): Promise<TaskAttempt>;

  insertApproval(approval: Approval): Promise<Approval>;
  updateApproval(id: string, expectedVersion: number, patch: ApprovalPatch): Promise<Approval>;
  /** Approvals past their expiry that nobody has decided. */
  findExpiredApprovals(now: Date, limit: number): Promise<Approval[]>;

  /** Append to the audit trail. The sequence number is assigned by the store. */
  appendEvent(event: Omit<Event, "id" | "sequence" | "at"> & { at?: Date }): Promise<Event>;

  enqueueOutbox(message: Omit<OutboxMessage, "id" | "createdAt" | "deliveredAt" | "lastError">): Promise<OutboxMessage>;
  claimOutbox(now: Date, limit: number): Promise<OutboxMessage[]>;
  markOutbox(id: string, patch: OutboxPatch): Promise<OutboxMessage>;
}

/* ------------------------------------------------------------------ patches ---- */

export type RunPatch = Partial<
  Pick<Run, "status" | "context" | "startedAt" | "finishedAt" | "error" | "labels">
>;

export type TaskPatch = Partial<
  Pick<
    Task,
    | "status"
    | "output"
    | "attempt"
    | "leasedBy"
    | "leaseExpiresAt"
    | "runAfter"
    | "approvalId"
    | "finishedAt"
    | "error"
  >
>;

export type ApprovalPatch = Partial<
  Pick<Approval, "status" | "decidedAt" | "decidedBy" | "decisionNote" | "editedPayload">
>;

export type OutboxPatch = Partial<
  Pick<OutboxMessage, "status" | "attempts" | "nextAttemptAt" | "deliveredAt" | "lastError">
>;

/* ------------------------------------------------------------------ queries ---- */

export interface LeaseParams {
  workerId: string;
  limit: number;
  /** Lease duration. A worker that dies loses its claim when this passes. */
  leaseMs: number;
  now: Date;
  /** Restrict to these handlers, so a worker can specialise. */
  handlers?: string[];
}

export interface RunFilter {
  status?: RunStatus[];
  workflow?: string;
  subjectId?: string;
  label?: { key: string; value: string };
  limit?: number;
  cursor?: string;
}

export interface ApprovalFilter {
  status?: ApprovalStatus[];
  runId?: string;
  limit?: number;
  cursor?: string;
}

export interface Page<T> {
  items: T[];
  /** Opaque. Pass it back as `cursor` for the next page; null means this is the last. */
  nextCursor: string | null;
}

export interface HarnessStats {
  runsByStatus: Record<string, number>;
  tasksByStatus: Record<string, number>;
  pendingApprovals: number;
  outboxPending: number;
  outboxFailed: number;
  quarantinedTasks: number;
}

/* ------------------------------------------------------------------- errors ---- */

export class VersionConflictError extends Error {
  constructor(
    readonly entity: string,
    readonly id: string,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(`${entity} ${id} was modified by someone else (expected version ${expected}, found ${actual})`);
    this.name = "VersionConflictError";
  }
}

export class NotFoundError extends Error {
  constructor(
    readonly entity: string,
    readonly id: string,
  ) {
    super(`${entity} ${id} does not exist`);
    this.name = "NotFoundError";
  }
}

export const EVENT_TYPES: readonly EventType[] = [
  "run.created",
  "run.started",
  "run.succeeded",
  "run.failed",
  "run.cancelled",
  "task.created",
  "task.ready",
  "task.leased",
  "task.succeeded",
  "task.failed",
  "task.retry_scheduled",
  "task.quarantined",
  "task.skipped",
  "task.lease_expired",
  "approval.requested",
  "approval.approved",
  "approval.rejected",
  "approval.expired",
  "outbox.enqueued",
  "outbox.delivered",
  "outbox.failed",
];

export const TASK_STATUSES: readonly TaskStatus[] = [
  "pending",
  "ready",
  "leased",
  "waiting_approval",
  "waiting_timer",
  "succeeded",
  "failed",
  "skipped",
  "quarantined",
  "cancelled",
];
