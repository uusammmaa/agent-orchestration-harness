import { z } from "zod";
import { ForbiddenError, NotFoundError, VersionConflictError, WorkflowNotFoundError, type Engine } from "@harness/core";

/**
 * The HTTP surface, as a framework-free router.
 *
 * Handlers take a parsed request and return a status and a body. That makes them
 * testable without a server, and it is why the Fastify wiring in `server.ts` is thirty
 * lines: this file holds the behaviour, that one holds the transport.
 *
 * Errors follow RFC 9457 problem+json. A client that has to regex an error string to
 * decide whether to retry is a client that will get it wrong.
 */

export interface AuthContext {
  /** Who is calling. Ends up in the audit trail as the actor. */
  subject: string;
  roles: string[];
}

export interface RouteRequest {
  params: Record<string, string>;
  query: Record<string, string | string[] | undefined>;
  body: unknown;
  auth: AuthContext;
}

export interface RouteResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export type RouteHandler = (request: RouteRequest) => Promise<RouteResponse>;

export interface Route {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  summary: string;
  /** Roles permitted to call it. Empty means any authenticated caller. */
  roles?: string[];
  handler: RouteHandler;
}

/* ------------------------------------------------------------------ schemas ---- */

const startRunBody = z.object({
  workflow: z.string().min(1),
  subjectId: z.string().min(1),
  input: z.record(z.string(), z.unknown()).default({}),
  idempotencyKey: z.string().min(1).max(200).optional(),
  labels: z.record(z.string(), z.string()).default({}),
});

const decisionBody = z.object({
  decision: z.enum(["approved", "rejected"]),
  note: z.string().max(2000).optional(),
  /** Present when the approver edited what they are approving. */
  editedPayload: z.record(z.string(), z.unknown()).optional(),
});

const cancelBody = z.object({ reason: z.string().min(3).max(500) });

const listRunsQuery = z.object({
  status: z.string().optional(),
  workflow: z.string().optional(),
  subjectId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

/* ------------------------------------------------------------------- errors ---- */

export function problem(status: number, title: string, detail?: string, extra: Record<string, unknown> = {}) {
  return {
    status,
    body: { type: `https://harness.dev/problems/${slug(title)}`, title, status, detail, ...extra },
    headers: { "content-type": "application/problem+json" },
  };
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Map a domain error onto the right status. */
export function toProblem(error: unknown): RouteResponse {
  if (error instanceof NotFoundError) return problem(404, "Not found", error.message);
  if (error instanceof ForbiddenError) return problem(403, "Forbidden", error.message);
  if (error instanceof WorkflowNotFoundError) return problem(400, "Unknown workflow", error.message);
  if (error instanceof VersionConflictError) {
    // 409 and retryable: the caller re-reads and tries again. A 500 would tell them to
    // give up on something that will almost certainly succeed next time.
    return problem(409, "Conflict", error.message, { retryable: true });
  }
  if (error instanceof z.ZodError) {
    return problem(422, "Invalid request", "The request body did not validate", {
      errors: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  return problem(500, "Internal error", error instanceof Error ? error.message : String(error));
}

/* ------------------------------------------------------------------- routes ---- */

export function buildRoutes(engine: Engine): Route[] {
  return [
    {
      method: "GET",
      path: "/health",
      summary: "Liveness and the resolved wiring",
      handler: async () => {
        const stats = await engine.store.reads.stats();
        return {
          status: 200,
          body: {
            status: "ok",
            workflows: engine.listWorkflows().map((workflow) => ({
              name: workflow.name,
              version: workflow.version,
              tasks: workflow.tasks.length,
            })),
            stats,
          },
        };
      },
    },

    {
      method: "GET",
      path: "/workflows",
      summary: "Registered workflows and their shape",
      handler: async () => ({
        status: 200,
        body: engine.listWorkflows().map((workflow) => ({
          name: workflow.name,
          version: workflow.version,
          description: workflow.description,
          subjectType: workflow.subjectType,
          tasks: workflow.tasks.map((task) => ({
            key: task.key,
            handler: task.handler,
            dependsOn: task.dependsOn ?? [],
            requires: task.requires ?? [],
            isApprovalGate: Boolean(task.approval),
            ...(task.approval
              ? { approvalRoles: task.approval.requiredRoles, expiresInHours: task.approval.expiresInHours }
              : {}),
          })),
        })),
      }),
    },

    {
      method: "POST",
      path: "/runs",
      summary: "Start a run",
      roles: ["operator", "ar_manager", "sales_manager", "service"],
      handler: async (request) => {
        const body = startRunBody.parse(request.body);
        const run = await engine.startRun({ ...body, actor: request.auth.subject });
        return {
          status: 201,
          body: run,
          headers: { location: `/runs/${run.id}` },
        };
      },
    },

    {
      method: "GET",
      path: "/runs",
      summary: "List runs",
      handler: async (request) => {
        const query = listRunsQuery.parse(request.query);
        const page = await engine.store.reads.listRuns({
          ...(query.status ? { status: query.status.split(",") as never } : {}),
          ...(query.workflow ? { workflow: query.workflow } : {}),
          ...(query.subjectId ? { subjectId: query.subjectId } : {}),
          limit: query.limit,
          ...(query.cursor ? { cursor: query.cursor } : {}),
        });
        return { status: 200, body: page };
      },
    },

    {
      method: "GET",
      path: "/runs/:id",
      summary: "A run with its tasks, approvals and events",
      handler: async (request) => {
        const id = request.params.id ?? "";
        const run = await engine.store.reads.getRun(id);
        if (!run) return problem(404, "Not found", `No run ${id}`);

        const [tasks, approvals, events] = await Promise.all([
          engine.store.reads.listTasks(id),
          engine.store.reads.listApprovals({ runId: id }),
          engine.store.reads.listEvents(id),
        ]);

        return { status: 200, body: { run, tasks, approvals: approvals.items, events } };
      },
    },

    {
      method: "POST",
      path: "/runs/:id/cancel",
      summary: "Cancel a run",
      roles: ["operator", "ar_manager", "sales_manager"],
      handler: async (request) => {
        const { reason } = cancelBody.parse(request.body);
        const run = await engine.cancelRun(request.params.id ?? "", request.auth.subject, reason);
        return { status: 200, body: run };
      },
    },

    {
      method: "GET",
      path: "/tasks/:id/attempts",
      summary: "Every attempt at a task, including the failures",
      handler: async (request) => ({
        status: 200,
        body: await engine.store.reads.listAttempts(request.params.id ?? ""),
      }),
    },

    {
      method: "POST",
      path: "/tasks/:id/requeue",
      summary: "Put a quarantined task back in the queue",
      roles: ["operator"],
      handler: async (request) => ({
        status: 200,
        body: await engine.requeueTask(request.params.id ?? "", request.auth.subject),
      }),
    },

    {
      method: "GET",
      path: "/approvals",
      summary: "The approval inbox",
      handler: async (request) => {
        const status = typeof request.query.status === "string" ? request.query.status : "pending";
        const page = await engine.store.reads.listApprovals({
          status: status.split(",") as never,
          limit: 100,
        });
        return { status: 200, body: page };
      },
    },

    {
      method: "GET",
      path: "/approvals/:id",
      summary: "One approval, with what it is gating",
      handler: async (request) => {
        const approval = await engine.store.reads.getApproval(request.params.id ?? "");
        if (!approval) return problem(404, "Not found", `No approval ${request.params.id}`);

        const [run, task] = await Promise.all([
          engine.store.reads.getRun(approval.runId),
          engine.store.reads.getTask(approval.taskId),
        ]);
        return { status: 200, body: { approval, run, task } };
      },
    },

    {
      method: "POST",
      path: "/approvals/:id/decision",
      summary: "Approve or reject",
      // Role is not checked here: the engine checks it against the approval's own
      // requiredRoles at decision time, which is the only check that can be right.
      handler: async (request) => {
        const body = decisionBody.parse(request.body);
        const approval = await engine.decideApproval({
          approvalId: request.params.id ?? "",
          decision: body.decision,
          decidedBy: request.auth.subject,
          roles: request.auth.roles,
          ...(body.note ? { note: body.note } : {}),
          ...(body.editedPayload ? { editedPayload: body.editedPayload } : {}),
        });
        return { status: 200, body: approval };
      },
    },

    {
      method: "GET",
      path: "/outbox",
      summary: "Undelivered and abandoned effects",
      roles: ["operator"],
      handler: async (request) => {
        const status = typeof request.query.status === "string" ? request.query.status : undefined;
        return {
          status: 200,
          body: await engine.store.reads.listOutbox({
            ...(status ? { status: status as never } : {}),
            limit: 200,
          }),
        };
      },
    },

    {
      method: "GET",
      path: "/stats",
      summary: "Counts for a dashboard",
      handler: async () => ({ status: 200, body: await engine.store.reads.stats() }),
    },
  ];
}

/** Minimal OpenAPI, generated from the route table so it cannot drift from the routes. */
export function openApiDocument(routes: Route[]): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of routes) {
    const path = route.path.replace(/:(\w+)/g, "{$1}");
    paths[path] ??= {};
    paths[path][route.method.toLowerCase()] = {
      summary: route.summary,
      ...(route.roles?.length ? { "x-required-roles": route.roles } : {}),
      parameters: [...route.path.matchAll(/:(\w+)/g)].map((match) => ({
        name: match[1],
        in: "path",
        required: true,
        schema: { type: "string" },
      })),
      responses: {
        "2XX": { description: "Success" },
        "4XX": { description: "problem+json", content: { "application/problem+json": {} } },
      },
    };
  }

  return {
    openapi: "3.1.0",
    info: { title: "Agent orchestration harness", version: "1.0.0" },
    paths,
  };
}
