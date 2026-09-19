import type { HarnessBundle } from "./harness";

/**
 * The read model.
 *
 * The engine's types are shaped for correctness; a screen needs different things —
 * a run's progress as a fraction, what is blocking it, how long an approval has left.
 * Computing that here rather than in the components keeps the UI dumb and means the same
 * projection can serve a different front end later.
 */

export interface ConsoleState {
  stats: {
    running: number;
    waitingApproval: number;
    failed: number;
    succeeded: number;
    pendingApprovals: number;
    quarantinedTasks: number;
    outboxPending: number;
    outboxAbandoned: number;
  };
  runs: RunView[];
  approvals: ApprovalView[];
  outbox: OutboxView[];
}

export interface RunView {
  id: string;
  workflow: string;
  subjectId: string;
  status: string;
  customer: string;
  priority: string;
  createdAt: string;
  finishedAt: string | null;
  /** 0–1, counting settled tasks. */
  progress: number;
  taskCount: number;
  /** One line saying what is happening, or what stopped it. */
  headline: string;
  error: string | null;
  tasks: TaskView[];
  events: EventView[];
}

export interface TaskView {
  id: string;
  key: string;
  handler: string;
  status: string;
  attempt: number;
  maxAttempts: number;
  isApprovalGate: boolean;
  error: string | null;
  durationMs: number | null;
  /** Attempts, so a reviewer can see it failed twice before it worked. */
  attempts: Array<{ attempt: number; outcome: string | null; error: string | null; durationMs: number | null }>;
  output: Record<string, unknown> | null;
}

export interface EventView {
  sequence: number;
  type: string;
  actor: string;
  at: string;
  detail: string;
}

export interface ApprovalView {
  id: string;
  runId: string;
  taskId: string;
  summary: string;
  status: string;
  requiredRoles: string[];
  requestedAt: string;
  expiresAt: string;
  /** Negative when it is already past its deadline. */
  hoursRemaining: number;
  workflow: string;
  customer: string;
  subject: string;
  bodyPreview: string;
  payload: Record<string, unknown>;
  decidedBy: string | null;
  decisionNote: string | null;
  wasEdited: boolean;
}

export interface OutboxView {
  id: string;
  channel: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  idempotencyKey: string;
  lastError: string | null;
  summary: string;
}

const GATE_HANDLER = "system.approval_gate";

export async function projectState(bundle: HarnessBundle): Promise<ConsoleState> {
  const { store, engine } = bundle;
  const page = await store.reads.listRuns({ limit: 100 });
  const approvalsPage = await store.reads.listApprovals({ limit: 100 });
  const outbox = await store.reads.listOutbox({ limit: 100 });
  const stats = await store.reads.stats();

  const runs: RunView[] = [];

  for (const run of page.items) {
    const tasks = await store.reads.listTasks(run.id);
    const events = await store.reads.listEvents(run.id);

    const taskViews: TaskView[] = [];
    for (const task of tasks) {
      const attempts = await store.reads.listAttempts(task.id);
      taskViews.push({
        id: task.id,
        key: task.key,
        handler: task.handler,
        status: task.status,
        attempt: task.attempt,
        maxAttempts: task.maxAttempts,
        isApprovalGate: task.handler === GATE_HANDLER,
        error: task.error?.message ?? null,
        durationMs: attempts.at(-1)?.durationMs ?? null,
        attempts: attempts.map((attempt) => ({
          attempt: attempt.attempt,
          outcome: attempt.outcome,
          error: attempt.error?.message ?? null,
          durationMs: attempt.durationMs,
        })),
        output: task.output,
      });
    }

    const settledCount = taskViews.filter((task) =>
      ["succeeded", "skipped", "cancelled", "failed", "quarantined"].includes(task.status),
    ).length;

    runs.push({
      id: run.id,
      workflow: run.workflow,
      subjectId: run.subjectId,
      status: run.status,
      customer: run.labels.customer ?? run.subjectId,
      priority: run.labels.priority ?? "normal",
      createdAt: run.createdAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      progress: taskViews.length === 0 ? 0 : settledCount / taskViews.length,
      taskCount: taskViews.length,
      headline: headlineFor(run.status, taskViews),
      error: run.error?.message ?? null,
      tasks: taskViews,
      events: events.map((event) => ({
        sequence: event.sequence,
        type: event.type,
        actor: event.actor,
        at: event.at.toISOString(),
        detail: describeEvent(event.type, event.payload),
      })),
    });
  }

  const byRun = new Map(runs.map((run) => [run.id, run]));

  const approvals: ApprovalView[] = approvalsPage.items.map((approval) => {
    const run = byRun.get(approval.runId);
    const payload = approval.payload as { subject?: string; body?: string };
    return {
      id: approval.id,
      runId: approval.runId,
      taskId: approval.taskId,
      summary: approval.summary,
      status: approval.status,
      requiredRoles: approval.requiredRoles,
      requestedAt: approval.requestedAt.toISOString(),
      expiresAt: approval.expiresAt.toISOString(),
      hoursRemaining: (approval.expiresAt.getTime() - Date.now()) / 3_600_000,
      workflow: run?.workflow ?? "unknown",
      customer: run?.customer ?? approval.runId,
      subject: payload.subject ?? "(no subject)",
      bodyPreview: (payload.body ?? "").slice(0, 400),
      payload: approval.payload,
      decidedBy: approval.decidedBy,
      decisionNote: approval.decisionNote,
      wasEdited: approval.editedPayload !== null,
    };
  });

  return {
    stats: {
      running: stats.runsByStatus.running ?? 0,
      waitingApproval: stats.runsByStatus.waiting_approval ?? 0,
      failed: stats.runsByStatus.failed ?? 0,
      succeeded: stats.runsByStatus.succeeded ?? 0,
      pendingApprovals: stats.pendingApprovals,
      quarantinedTasks: stats.quarantinedTasks,
      outboxPending: stats.outboxPending,
      outboxAbandoned: stats.outboxFailed,
    },
    runs,
    approvals,
    outbox: outbox.map((message) => ({
      id: message.id,
      channel: message.channel,
      status: message.status,
      attempts: message.attempts,
      maxAttempts: message.maxAttempts,
      idempotencyKey: message.idempotencyKey,
      lastError: message.lastError,
      summary: summariseEffect(message.channel, message.payload),
    })),
  };
  void engine;
}

/** What a person needs to know about this run in one line. */
function headlineFor(status: string, tasks: TaskView[]): string {
  if (status === "waiting_approval") {
    const gate = tasks.find((task) => task.status === "waiting_approval");
    return gate ? `Waiting on a decision at ${gate.key.replace(/_/g, " ")}` : "Waiting on a decision";
  }
  if (status === "failed") {
    const broken = tasks.find((task) => task.status === "failed" || task.status === "quarantined");
    return broken ? `Stopped at ${broken.key.replace(/_/g, " ")}: ${broken.error ?? "no reason recorded"}` : "Stopped";
  }
  if (status === "succeeded") {
    const skipped = tasks.filter((task) => task.status === "skipped").length;
    return skipped > 0 ? `Finished, with ${skipped} step${skipped === 1 ? "" : "s"} skipped` : "Finished";
  }
  if (status === "cancelled") return "Cancelled";

  const active = tasks.find((task) => task.status === "leased" || task.status === "ready");
  return active ? `Working on ${active.key.replace(/_/g, " ")}` : "Queued";
}

function describeEvent(type: string, payload: Record<string, unknown>): string {
  switch (type) {
    case "run.created":
      return `${String(payload.workflow)} for ${String(payload.subjectId)}`;
    case "task.ready":
      return payload.requeued ? `${String(payload.key ?? "task")} requeued by hand` : String(payload.key ?? "");
    case "task.leased":
      return `attempt ${String(payload.attempt)}`;
    case "task.succeeded":
      return `${String(payload.key)} on attempt ${String(payload.attempt)}`;
    case "task.failed":
    case "task.quarantined":
      return `${String(payload.code)}: ${String(payload.message)}`;
    case "task.retry_scheduled":
      return `${String(payload.code)}, retrying in ${String(payload.delayMs)}ms`;
    case "task.skipped":
      return `${String(payload.key)} — ${String(payload.reason)}`;
    case "task.lease_expired":
      return `worker ${String(payload.previousWorker ?? "unknown")} stopped responding`;
    case "approval.requested":
      return String(payload.summary ?? "");
    case "approval.approved":
      return payload.edited ? "approved, with edits" : String(payload.note ?? "approved");
    case "approval.rejected":
      return String(payload.note ?? "rejected");
    case "approval.expired":
      return "nobody decided in time";
    case "outbox.enqueued":
      return String(payload.channel ?? "");
    case "run.failed":
      return `at ${String(payload.taskKey ?? "an unknown step")}`;
    default:
      return "";
  }
}

function summariseEffect(channel: string, payload: Record<string, unknown>): string {
  if (channel === "email.send") return `to ${String(payload.to ?? "unknown")} — ${String(payload.subject ?? "")}`;
  if (channel === "ticket.create") return `${String(payload.queue ?? "queue")}: ${String(payload.subject ?? "")}`;
  if (channel === "run.schedule") return `next run ${String(payload.runAt ?? "")}`;
  return JSON.stringify(payload).slice(0, 120);
}
