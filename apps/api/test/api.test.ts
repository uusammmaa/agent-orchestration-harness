import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { buildHarness, createApiServer, matchRoute, type Harness } from "../src/server";
import { buildRoutes } from "../src/routes";

/**
 * The API over real HTTP.
 *
 * Against the in-memory store and the stub Odoo, so it runs anywhere — but through an
 * actual socket, because the things most likely to be wrong at this layer are routing,
 * status codes and error shapes, and none of those are exercised by calling a handler
 * directly.
 */

let harness: Harness;
let server: Server;
let base: string;

beforeAll(async () => {
  harness = await buildHarness({ env: {} });
  server = createApiServer(harness);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await harness.close();
});

interface CallOptions {
  method?: string;
  body?: unknown;
  user?: string;
  roles?: string[];
}

async function call(path: string, options: CallOptions = {}) {
  const response = await fetch(`${base}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "content-type": "application/json",
      "x-harness-user": options.user ?? "tester",
      "x-harness-roles": (options.roles ?? ["operator", "ar_manager"]).join(","),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    body: text ? (JSON.parse(text) as Record<string, unknown>) : undefined,
    location: response.headers.get("location"),
  };
}

describe("routing", () => {
  const routes = buildRoutes(harness?.engine ?? ({} as never));

  it("matches a literal path", () => {
    expect(matchRoute(routes, "GET", "/health")?.route.path).toBe("/health");
  });

  it("extracts path parameters", () => {
    const matched = matchRoute(routes, "GET", "/runs/run_123");
    expect(matched?.route.path).toBe("/runs/:id");
    expect(matched?.params.id).toBe("run_123");
  });

  it("does not confuse a collection with an item", () => {
    expect(matchRoute(routes, "GET", "/runs")?.route.path).toBe("/runs");
    expect(matchRoute(routes, "GET", "/runs/a/b")).toBeNull();
  });

  it("distinguishes methods on the same path", () => {
    expect(matchRoute(routes, "POST", "/runs")?.route.method).toBe("POST");
    expect(matchRoute(routes, "DELETE", "/runs")).toBeNull();
  });

  it("decodes an encoded parameter", () => {
    expect(matchRoute(routes, "GET", "/runs/run%2F123")?.params.id).toBe("run/123");
  });
});

describe("health and discovery", () => {
  it("reports the registered workflows", async () => {
    const response = await call("/health");
    expect(response.status).toBe(200);
    expect(response.body?.status).toBe("ok");
    expect((response.body?.workflows as unknown[]).length).toBe(2);
  });

  it("describes each workflow, including which tasks are approval gates", async () => {
    const response = await call("/workflows");
    const workflows = response.body as unknown as Array<{ name: string; tasks: Array<{ key: string; isApprovalGate: boolean }> }>;

    const collections = workflows.find((workflow) => workflow.name === "ar_collections");
    expect(collections?.tasks.find((task) => task.key === "approve_message")?.isApprovalGate).toBe(true);
    expect(collections?.tasks.find((task) => task.key === "send_message")?.isApprovalGate).toBe(false);
  });

  it("serves an OpenAPI document generated from the routes", async () => {
    const response = await fetch(`${base}/openapi.json`);
    const document = (await response.json()) as { openapi: string; paths: Record<string, unknown> };

    expect(document.openapi).toBe("3.1.0");
    expect(document.paths["/runs/{id}"]).toBeDefined();
    expect(document.paths["/approvals/{id}/decision"]).toBeDefined();
  });
});

describe("runs", () => {
  it("starts a run and returns where to find it", async () => {
    const response = await call("/runs", {
      method: "POST",
      body: { workflow: "ar_collections", subjectId: "5001", input: { invoiceId: 5001 } },
    });

    expect(response.status).toBe(201);
    expect(response.location).toMatch(/^\/runs\/run_/);
    expect(response.body?.status).toBe("running");
  });

  it("records the caller as the actor, not 'system'", async () => {
    const created = await call("/runs", {
      method: "POST",
      body: { workflow: "ar_collections", subjectId: "5002", input: { invoiceId: 5002 } },
      user: "ana@example.com",
    });

    const detail = await call(`/runs/${created.body?.id}`);
    const events = detail.body?.events as Array<{ type: string; actor: string }>;
    expect(events.find((event) => event.type === "run.created")?.actor).toBe("ana@example.com");
  });

  it("returns the same run for a repeated idempotency key", async () => {
    const body = {
      workflow: "ar_collections",
      subjectId: "5003",
      input: { invoiceId: 5003 },
      idempotencyKey: "api-test-key",
    };

    const first = await call("/runs", { method: "POST", body });
    const second = await call("/runs", { method: "POST", body });
    expect(second.body?.id).toBe(first.body?.id);
  });

  it("rejects an unknown workflow with 400, not 500", async () => {
    const response = await call("/runs", {
      method: "POST",
      body: { workflow: "nope", subjectId: "x", input: {} },
    });

    expect(response.status).toBe(400);
    expect(response.contentType).toContain("application/problem+json");
    expect(response.body?.title).toBe("Unknown workflow");
  });

  it("returns 422 with the offending fields for a malformed body", async () => {
    const response = await call("/runs", { method: "POST", body: { subjectId: 42 } });

    expect(response.status).toBe(422);
    const errors = response.body?.errors as Array<{ path: string }>;
    expect(errors.map((error) => error.path)).toContain("workflow");
  });

  it("returns a run with its tasks, approvals and events", async () => {
    const created = await call("/runs", {
      method: "POST",
      body: { workflow: "lead_followup", subjectId: "7001", input: { leadId: 7001 } },
    });

    const detail = await call(`/runs/${created.body?.id}`);
    expect(detail.status).toBe(200);
    expect((detail.body?.tasks as unknown[]).length).toBeGreaterThan(0);
    expect((detail.body?.events as unknown[]).length).toBeGreaterThan(0);
  });

  it("404s an unknown run as problem+json", async () => {
    const response = await call("/runs/run_does_not_exist");
    expect(response.status).toBe(404);
    expect(response.contentType).toContain("application/problem+json");
  });

  it("filters by workflow", async () => {
    const response = await call("/runs?workflow=lead_followup&limit=50");
    const page = response.body as unknown as { items: Array<{ workflow: string }> };
    expect(page.items.every((run) => run.workflow === "lead_followup")).toBe(true);
  });
});

describe("authorisation", () => {
  it("refuses to start a run without a permitted role", async () => {
    const response = await call("/runs", {
      method: "POST",
      body: { workflow: "ar_collections", subjectId: "5001", input: { invoiceId: 5001 } },
      roles: ["viewer"],
    });

    expect(response.status).toBe(403);
    expect(response.body?.detail).toMatch(/needs one of/);
  });

  it("lets anyone read", async () => {
    expect((await call("/runs", { roles: [] })).status).toBe(200);
    expect((await call("/stats", { roles: [] })).status).toBe(200);
  });

  it("guards the outbox behind the operator role", async () => {
    expect((await call("/outbox", { roles: ["viewer"] })).status).toBe(403);
    expect((await call("/outbox", { roles: ["operator"] })).status).toBe(200);
  });
});

describe("approvals", () => {
  async function reachAnApproval() {
    const created = await call("/runs", {
      method: "POST",
      body: { workflow: "ar_collections", subjectId: "5001", input: { invoiceId: 5001 } },
    });

    // Drive the worker until the gate is reached.
    for (let i = 0; i < 12; i++) {
      const leased = await harness.worker.tick();
      await harness.worker.drain();
      if (leased === 0) break;
    }

    const inbox = await call("/approvals?status=pending");
    const approvals = (inbox.body as unknown as { items: Array<{ id: string; runId: string }> }).items;
    const approval = approvals.find((candidate) => candidate.runId === created.body?.id);
    return { runId: String(created.body?.id), approval };
  }

  it("puts the gate in the inbox with its run and task attached", async () => {
    const { approval } = await reachAnApproval();
    expect(approval).toBeDefined();

    const detail = await call(`/approvals/${approval!.id}`);
    expect(detail.status).toBe(200);
    expect((detail.body?.run as { id: string }).id).toBe(approval!.runId);
    expect((detail.body?.task as { status: string }).status).toBe("waiting_approval");
  });

  it("refuses a decision from somebody without the role the approval requires", async () => {
    const { approval } = await reachAnApproval();

    const response = await call(`/approvals/${approval!.id}/decision`, {
      method: "POST",
      body: { decision: "approved" },
      roles: ["viewer"],
    });

    expect(response.status).toBe(403);
    expect(response.body?.detail).toMatch(/ar_clerk|ar_manager/);
  });

  it("accepts a decision and records who made it", async () => {
    const { approval } = await reachAnApproval();

    const response = await call(`/approvals/${approval!.id}/decision`, {
      method: "POST",
      body: { decision: "approved", note: "Checked with the account manager" },
      user: "ana@example.com",
      roles: ["ar_manager"],
    });

    expect(response.status).toBe(200);
    expect(response.body?.status).toBe("approved");
    expect(response.body?.decidedBy).toBe("ana@example.com");
    expect(response.body?.decisionNote).toBe("Checked with the account manager");
  });

  it("refuses a second decision with 403, not 500", async () => {
    const { approval } = await reachAnApproval();
    const body = { decision: "approved" as const };

    await call(`/approvals/${approval!.id}/decision`, { method: "POST", body, roles: ["ar_manager"] });
    const second = await call(`/approvals/${approval!.id}/decision`, { method: "POST", body, roles: ["ar_manager"] });

    expect(second.status).toBe(403);
    expect(second.body?.detail).toMatch(/already approved/);
  });

  it("keeps an edited payload separate from what was proposed", async () => {
    const { approval } = await reachAnApproval();

    const response = await call(`/approvals/${approval!.id}/decision`, {
      method: "POST",
      body: { decision: "approved", editedPayload: { subject: "Reworded", body: "A softer version of the reminder." } },
      roles: ["ar_manager"],
    });

    expect(response.body?.editedPayload).toMatchObject({ subject: "Reworded" });
    expect(response.body?.payload).not.toMatchObject({ subject: "Reworded" });
  });
});

describe("error handling", () => {
  it("404s an unknown path as problem+json", async () => {
    const response = await call("/no/such/thing");
    expect(response.status).toBe(404);
    expect(response.body?.title).toBe("Not found");
  });

  it("400s a body that is not JSON", async () => {
    const response = await fetch(`${base}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-harness-roles": "operator" },
      body: "{not json",
    });
    expect(response.status).toBe(400);
  });

  it("403s a requeue of a task that is not quarantined", async () => {
    const created = await call("/runs", {
      method: "POST",
      body: { workflow: "ar_collections", subjectId: "5001", input: { invoiceId: 5001 } },
    });
    const detail = await call(`/runs/${created.body?.id}`);
    const task = (detail.body?.tasks as Array<{ id: string }>)[0];

    const response = await call(`/tasks/${task?.id}/requeue`, { method: "POST", body: {}, roles: ["operator"] });
    expect(response.status).toBe(403);
  });
});
