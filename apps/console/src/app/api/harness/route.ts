import { z } from "zod";
import { ForbiddenError, NotFoundError, type StoreSnapshot } from "@harness/core";
import { buildHarness, seedDemo, settle, type DeliveredEffect } from "@/lib/harness";
import { projectState, type ConsoleState } from "@/lib/project";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * One endpoint, several actions.
 *
 * The browser posts the store snapshot and what it wants to do; the server rehydrates,
 * acts, settles the worker, and returns the new snapshot plus a projection shaped for the
 * screen. Keeping the projection server-side means the client never has to know the
 * engine's internal model, and the payload stays small.
 */

const snapshotSchema = z.object({
  runs: z.array(z.record(z.string(), z.unknown())),
  tasks: z.array(z.record(z.string(), z.unknown())),
  attempts: z.array(z.record(z.string(), z.unknown())),
  approvals: z.array(z.record(z.string(), z.unknown())),
  events: z.array(z.record(z.string(), z.unknown())),
  outbox: z.array(z.record(z.string(), z.unknown())),
  counter: z.number(),
});

const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("seed") }),
  z.object({ action: z.literal("refresh"), snapshot: snapshotSchema }),
  z.object({
    action: z.literal("decide"),
    snapshot: snapshotSchema,
    approvalId: z.string(),
    decision: z.enum(["approved", "rejected"]),
    note: z.string().max(1000).optional(),
    editedPayload: z.record(z.string(), z.unknown()).optional(),
    actor: z.string().default("you@example.com"),
    roles: z.array(z.string()).default(["ar_manager", "sales_manager"]),
  }),
  z.object({
    action: z.literal("start"),
    snapshot: snapshotSchema,
    workflow: z.string(),
    subjectId: z.string(),
    input: z.record(z.string(), z.unknown()),
    labels: z.record(z.string(), z.string()).default({}),
  }),
  z.object({ action: z.literal("requeue"), snapshot: snapshotSchema, taskId: z.string() }),
  z.object({ action: z.literal("cancel"), snapshot: snapshotSchema, runId: z.string(), reason: z.string() }),
  z.object({ action: z.literal("expire"), snapshot: snapshotSchema }),
]);

export interface HarnessResponse {
  snapshot: StoreSnapshot;
  state: ConsoleState;
  delivered: DeliveredEffect[];
  /** What just happened, in words, for the activity strip. */
  message: string;
}

export async function POST(request: Request): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return problem(400, "Body must be JSON");
  }

  const parsed = body.safeParse(payload);
  if (!parsed.success) {
    return problem(422, "Invalid request", parsed.error.issues.map((issue) => issue.message).join("; "));
  }

  const command = parsed.data;

  if (command.action === "seed") {
    const snapshot = await seedDemo();
    const bundle = buildHarness(snapshot);
    return Response.json({
      snapshot,
      state: await projectState(bundle),
      delivered: [],
      message: "Loaded six runs at six different points.",
    } satisfies HarnessResponse);
  }

  const bundle = buildHarness(command.snapshot as StoreSnapshot);
  let message = "";

  try {
    switch (command.action) {
      case "refresh":
        // Still runs the worker: a run whose retry backoff has elapsed should pick up.
        message = "Refreshed.";
        break;

      case "decide": {
        const approval = await bundle.engine.decideApproval({
          approvalId: command.approvalId,
          decision: command.decision,
          decidedBy: command.actor,
          roles: command.roles,
          ...(command.note ? { note: command.note } : {}),
          ...(command.editedPayload ? { editedPayload: command.editedPayload } : {}),
        });
        message =
          command.decision === "approved"
            ? `Approved. ${command.editedPayload ? "Your edit is what was approved, and the record says so." : "The run has resumed."}`
            : "Rejected. Nothing was sent, and the reason is on the record.";
        void approval;
        break;
      }

      case "start": {
        const run = await bundle.engine.startRun({
          workflow: command.workflow,
          subjectId: command.subjectId,
          input: command.input,
          labels: command.labels,
          actor: "you@example.com",
        });
        message = `Started ${command.workflow} for ${command.subjectId} (${run.id}).`;
        break;
      }

      case "requeue":
        await bundle.engine.requeueTask(command.taskId, "you@example.com");
        message = "Requeued. It will be picked up on the next tick.";
        break;

      case "cancel":
        await bundle.engine.cancelRun(command.runId, "you@example.com", command.reason);
        message = "Cancelled. Anything already finished stays finished.";
        break;

      case "expire": {
        const expired = await bundle.engine.expireApprovals();
        message =
          expired.length === 0
            ? "Nothing was past its deadline."
            : `${expired.length} approval${expired.length === 1 ? "" : "s"} expired. Nothing was sent.`;
        break;
      }
    }

    await settle(bundle);

    return Response.json({
      snapshot: bundle.store.snapshot(),
      state: await projectState(bundle),
      delivered: bundle.delivered,
      message,
    } satisfies HarnessResponse);
  } catch (error) {
    if (error instanceof ForbiddenError) return problem(403, "Not allowed", error.message);
    if (error instanceof NotFoundError) return problem(404, "Not found", error.message);
    return problem(500, "Something went wrong", error instanceof Error ? error.message : String(error));
  }
}

function problem(status: number, title: string, detail?: string): Response {
  return Response.json({ title, status, detail }, { status });
}
