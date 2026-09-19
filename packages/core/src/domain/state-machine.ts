import type { RunStatus, TaskStatus } from "./types";

/**
 * Legal transitions for runs and tasks.
 *
 * This table is the single definition of what can happen. It is enforced twice: here,
 * before any write is attempted, and again in Postgres by a trigger generated from the
 * same data (see `migrations/0002_state_machine.sql`). Two enforcement points sounds
 * redundant until a worker on an old deployment tries to move a task from `succeeded`
 * back to `leased` and the database refuses it.
 *
 * Terminal states have no outgoing edges. That is what makes "can this run still change?"
 * a lookup rather than a judgement.
 */

export const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  pending: ["running", "cancelled", "failed"],
  running: ["waiting_approval", "waiting_timer", "succeeded", "failed", "cancelled"],
  waiting_approval: ["running", "failed", "cancelled"],
  waiting_timer: ["running", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  pending: ["ready", "skipped", "cancelled"],
  ready: ["leased", "skipped", "cancelled", "waiting_approval"],
  // A lease can expire back to ready, which is how a crashed worker's task is recovered.
  leased: ["succeeded", "failed", "ready", "waiting_timer", "waiting_approval", "quarantined", "cancelled"],
  waiting_approval: ["ready", "skipped", "failed", "cancelled"],
  waiting_timer: ["ready", "cancelled", "failed"],
  failed: ["ready", "quarantined"],
  succeeded: [],
  skipped: [],
  quarantined: [],
  cancelled: [],
};

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ["succeeded", "failed", "cancelled"];
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ["succeeded", "skipped", "quarantined", "cancelled"];

export function canRunTransition(from: RunStatus, to: RunStatus): boolean {
  return from === to || RUN_TRANSITIONS[from].includes(to);
}

export function canTaskTransition(from: TaskStatus, to: TaskStatus): boolean {
  return from === to || TASK_TRANSITIONS[from].includes(to);
}

export function isRunTerminal(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

export function isTaskTerminal(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.includes(status);
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly entity: "run" | "task",
    readonly id: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(`${entity} ${id}: ${from} -> ${to} is not a legal transition`);
    this.name = "IllegalTransitionError";
  }
}

export function assertRunTransition(id: string, from: RunStatus, to: RunStatus): void {
  if (!canRunTransition(from, to)) throw new IllegalTransitionError("run", id, from, to);
}

export function assertTaskTransition(id: string, from: TaskStatus, to: TaskStatus): void {
  if (!canTaskTransition(from, to)) throw new IllegalTransitionError("task", id, from, to);
}

/**
 * The run status implied by the states of its tasks.
 *
 * Run status is derived, not independently maintained. Keeping it as a separate fact that
 * someone remembers to update is how a run ends up marked `running` for three weeks with
 * every task finished.
 */
export function deriveRunStatus(
  taskStatuses: readonly TaskStatus[],
  current: RunStatus,
): RunStatus {
  if (isRunTerminal(current)) return current;
  if (taskStatuses.length === 0) return current;

  /*
   * A task in `failed` or `quarantined` has stopped being tried. The engine puts a
   * retryable failure back to `ready` with a backoff, so reaching either of these means
   * the work is not going to happen without a person.
   *
   * Both fail the run. They are distinct on the *task* — `failed` is permanent, and
   * `quarantined` is "retryable, but we have given up" — and that distinction is what
   * tells an operator whether requeueing is worth trying. At the run level the answer is
   * the same either way: this is not going to finish on its own.
   */
  if (taskStatuses.includes("quarantined") || taskStatuses.includes("failed")) return "failed";

  const allSettled = taskStatuses.every(
    (status) => status === "succeeded" || status === "skipped" || status === "cancelled",
  );
  if (allSettled) {
    return taskStatuses.some((status) => status === "cancelled") ? "cancelled" : "succeeded";
  }

  // Waiting beats running: a run blocked on a person should not look busy on a dashboard.
  if (taskStatuses.includes("waiting_approval")) return "waiting_approval";

  const active = taskStatuses.some(
    (status) => status === "ready" || status === "leased" || status === "pending",
  );
  if (!active && taskStatuses.includes("waiting_timer")) return "waiting_timer";

  return "running";
}
