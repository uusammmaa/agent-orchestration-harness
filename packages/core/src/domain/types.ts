/**
 * The durable execution model.
 *
 * A `Run` is one instance of a workflow. It owns `Task`s, which are the units of work
 * that get leased, executed and retried. Each execution of a task is a `TaskAttempt`,
 * recorded whether it succeeded or not, because "this failed four times before it worked"
 * is the thing you need six weeks later and cannot reconstruct.
 *
 * Nothing here does I/O. The engine is a state machine over these types; storage,
 * agents and ERP calls all arrive through ports.
 */

export type RunStatus =
  | "pending"
  | "running"
  | "waiting_approval"
  | "waiting_timer"
  | "succeeded"
  | "failed"
  | "cancelled";

export type TaskStatus =
  | "pending"
  | "ready"
  | "leased"
  | "waiting_approval"
  | "waiting_timer"
  | "succeeded"
  | "failed"
  | "skipped"
  | "quarantined"
  | "cancelled";

export type AttemptOutcome = "succeeded" | "failed" | "lease_expired" | "cancelled";

export interface Run {
  id: string;
  workflow: string;
  workflowVersion: number;
  status: RunStatus;
  /** Business key this run is about: an invoice, a lead, a customer. */
  subjectType: string;
  subjectId: string;
  /** Immutable input the workflow was started with. */
  input: Record<string, unknown>;
  /** Accumulated output, written by tasks as they complete. */
  context: Record<string, unknown>;
  /** Supplied by the caller so a retried start does not create a second run. */
  idempotencyKey: string | null;
  /** Optimistic-concurrency token. Every write checks and bumps it. */
  version: number;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  /** Set when the run ends badly. */
  error: RunError | null;
  /** Free-form labels for filtering: tenant, priority, campaign. */
  labels: Record<string, string>;
}

export interface RunError {
  code: string;
  message: string;
  taskId?: string;
  at: string;
}

export interface Task {
  id: string;
  runId: string;
  /** Stable within a workflow definition, so a task can be found by name. */
  key: string;
  /** Which agent or system handler executes it. */
  handler: string;
  status: TaskStatus;
  /** Task keys that must have settled before this becomes ready. */
  dependsOn: string[];
  /** Task keys that must have *succeeded*. See TaskDefinition.requires. */
  requires: string[];
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  attempt: number;
  maxAttempts: number;
  /** Worker currently holding the lease, if any. */
  leasedBy: string | null;
  leaseExpiresAt: Date | null;
  /** When a task is asleep until — retry backoff, or a scheduled follow-up. */
  runAfter: Date | null;
  /** Set while the task is blocked on a human. */
  approvalId: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
  error: TaskError | null;
}

export interface TaskError {
  code: string;
  message: string;
  retryable: boolean;
  at: string;
}

export interface TaskAttempt {
  id: string;
  taskId: string;
  runId: string;
  attempt: number;
  workerId: string;
  startedAt: Date;
  finishedAt: Date | null;
  outcome: AttemptOutcome | null;
  error: TaskError | null;
  /** Milliseconds the handler ran for. Null while in flight. */
  durationMs: number | null;
}

/* ---------------------------------------------------------------- approvals ---- */

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "cancelled";

export interface Approval {
  id: string;
  runId: string;
  taskId: string;
  /** What the approver is being asked to allow, in their words. */
  summary: string;
  /** The payload they are approving. Shown verbatim; this is the record. */
  payload: Record<string, unknown>;
  /** Roles permitted to decide. Checked at decision time, not at creation. */
  requiredRoles: string[];
  status: ApprovalStatus;
  requestedAt: Date;
  expiresAt: Date;
  decidedAt: Date | null;
  decidedBy: string | null;
  /** Free text from the approver. Kept forever; this is the audit trail. */
  decisionNote: string | null;
  /**
   * What the approver actually approved, if they edited it. An approval of an edited
   * draft is not an approval of the original, and conflating the two is how a system
   * ends up sending something nobody agreed to.
   */
  editedPayload: Record<string, unknown> | null;
  version: number;
}

/* ------------------------------------------------------------------- events ---- */

export type EventType =
  | "run.created"
  | "run.started"
  | "run.succeeded"
  | "run.failed"
  | "run.cancelled"
  | "task.created"
  | "task.ready"
  | "task.leased"
  | "task.succeeded"
  | "task.failed"
  | "task.retry_scheduled"
  | "task.quarantined"
  | "task.skipped"
  | "task.lease_expired"
  | "approval.requested"
  | "approval.approved"
  | "approval.rejected"
  | "approval.expired"
  | "outbox.enqueued"
  | "outbox.delivered"
  | "outbox.failed";

/**
 * The audit trail. Append-only, never updated, never deleted.
 *
 * Run and task rows are the current state; this is how that state came to be. When
 * finance asks why a customer was chased twice in a week, the answer is in here.
 */
export interface Event {
  id: string;
  runId: string;
  taskId: string | null;
  type: EventType;
  /** Monotonic within a run, so events can be ordered without relying on timestamps. */
  sequence: number;
  /** Who or what caused it: a worker id, a user id, or "system". */
  actor: string;
  payload: Record<string, unknown>;
  at: Date;
}

/* ------------------------------------------------------------------ outbox ---- */

export type OutboxStatus = "pending" | "delivered" | "failed" | "abandoned";

/**
 * Transactional outbox.
 *
 * An effect that leaves the system — an email, an Odoo write — is committed in the same
 * transaction as the state change that decided on it. A separate dispatcher delivers it
 * afterwards. Without this, a crash between "mark the task done" and "send the email"
 * either loses the email or sends it twice, and which one you get is luck.
 */
export interface OutboxMessage {
  id: string;
  runId: string;
  taskId: string | null;
  /** Destination: `odoo.log_activity`, `email.send`, `webhook.post`. */
  channel: string;
  payload: Record<string, unknown>;
  /** Deduplication key the receiving side honours. */
  idempotencyKey: string;
  status: OutboxStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  createdAt: Date;
  deliveredAt: Date | null;
  lastError: string | null;
}

/* --------------------------------------------------------------- workflows ---- */

export interface TaskDefinition {
  key: string;
  handler: string;
  /**
   * Task keys that must have *settled* — succeeded or skipped — before this one runs.
   * Use this for ordering when a skipped branch should not hold the run up.
   */
  dependsOn?: string[];
  /**
   * Task keys that must have *succeeded*.
   *
   * The distinction matters most at an approval gate. A gate that was skipped because it
   * was not needed should let the work through; a gate that was skipped because somebody
   * rejected it must not. `dependsOn` cannot tell those apart, because both leave the
   * task `skipped` — so anything that must not happen without a real success says so
   * here, and is skipped in turn if its requirement was not met.
   */
  requires?: string[];
  maxAttempts?: number;
  /** Build this task's input from the run input and what earlier tasks produced. */
  input?: (context: WorkflowContext) => Record<string, unknown>;
  /** Skip the task entirely when this returns false. */
  when?: (context: WorkflowContext) => boolean;
  /** Turns this task into an approval gate. */
  approval?: ApprovalSpec;
}

export interface ApprovalSpec {
  summary: (context: WorkflowContext) => string;
  requiredRoles: string[];
  /** Hours before the approval expires. */
  expiresInHours: number;
  /** What happens when nobody decides in time. */
  onExpiry: "fail" | "skip" | "auto_approve";
}

export interface WorkflowContext {
  runId: string;
  input: Record<string, unknown>;
  /** Outputs of completed tasks, keyed by task key. */
  outputs: Record<string, Record<string, unknown>>;
  labels: Record<string, string>;
}

export interface WorkflowDefinition {
  name: string;
  version: number;
  description: string;
  subjectType: string;
  tasks: TaskDefinition[];
  /** Fail the whole run if it has not finished within this many hours. */
  timeoutHours?: number;
}
