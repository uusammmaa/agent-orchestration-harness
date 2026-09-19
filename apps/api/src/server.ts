import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  Engine,
  MemoryStore,
  OutboxDispatcher,
  Worker,
  arCollections,
  leadFollowup,
  type Store,
} from "@harness/core";
import { PostgresStore, migrate } from "@harness/core/postgres";
import { OdooClient, OdooStub, seedStub } from "@harness/odoo";
import { AnthropicBrain, RulesBrain, buildHandlers } from "@harness/agents";
import { buildRoutes, openApiDocument, toProblem, type AuthContext, type Route } from "./routes";

/**
 * The API and worker, in one process.
 *
 * Deliberately one binary with a flag rather than two. A small deployment runs it as a
 * single container and gets an API that also does the work; a larger one runs several
 * with `ROLE=worker` and one with `ROLE=api`, and nothing about the code changes. Forcing
 * two processes on a shop that has thirty invoices a day is how good architecture becomes
 * an operational burden.
 *
 * No framework. The routes are a table of pure functions, so the HTTP layer is this file,
 * and it is small enough to read in one go.
 */

export interface BuildOptions {
  env?: Record<string, string | undefined>;
}

export interface Harness {
  engine: Engine;
  worker: Worker;
  dispatcher: OutboxDispatcher;
  routes: Route[];
  store: Store;
  mode: { store: string; odoo: string; brain: string };
  close: () => Promise<void>;
}

export async function buildHarness(options: BuildOptions = {}): Promise<Harness> {
  const env = options.env ?? process.env;

  /* ---- store ---------------------------------------------------------- */
  let store: Store;
  let storeMode = "memory";

  if (env.DATABASE_URL) {
    const postgres = new PostgresStore({
      connectionString: env.DATABASE_URL,
      ...(env.DATABASE_SSL === "1" ? { ssl: { rejectUnauthorized: false } } : {}),
    });
    // Migrate on boot. Safe because the runner takes an advisory lock, so several
    // instances starting together do not race.
    await migrate(postgres.rawPool);
    store = postgres;
    storeMode = "postgres";
  } else {
    store = new MemoryStore();
  }

  /* ---- odoo ----------------------------------------------------------- */
  let odoo = OdooClient.fromEnv(env);
  let odooMode = "live";

  if (!odoo) {
    // A stub, seeded with a small realistic company, so the whole thing runs with no
    // credentials at all. The mode is reported rather than hidden.
    const stub = new OdooStub();
    seedStub(stub);
    odoo = new OdooClient({
      url: "https://erp.stub",
      db: "harness",
      username: "bot@example.com",
      password: "secret",
      fetchImpl: stub.fetch,
    });
    odooMode = "stub";
  }

  /* ---- brain ----------------------------------------------------------- */
  const anthropic = AnthropicBrain.fromEnv(env);
  const brain = anthropic ?? new RulesBrain();

  const engine = new Engine({ store, workflows: [arCollections, leadFollowup] });
  const handlers = buildHandlers({ odoo, brain });

  const worker = new Worker({
    engine,
    handlers,
    concurrency: Number(env.WORKER_CONCURRENCY ?? 4),
    leaseMs: Number(env.WORKER_LEASE_MS ?? 30_000),
    pollMs: Number(env.WORKER_POLL_MS ?? 500),
    runMaintenance: true,
    logger: {
      info: (message) => console.log(JSON.stringify({ level: "info", message })),
      error: (message, meta) => console.error(JSON.stringify({ level: "error", message, meta: String(meta) })),
    },
  });

  const dispatcher = new OutboxDispatcher({
    engine,
    channels: {
      // In a real deployment these are SES, an internal ticket API and a scheduler. They
      // are logged here so the demo is honest about not sending anything.
      "email.send": async (payload, key) => {
        console.log(JSON.stringify({ level: "info", channel: "email.send", key, to: payload.to }));
      },
      "ticket.create": async (payload, key) => {
        console.log(JSON.stringify({ level: "info", channel: "ticket.create", key, queue: payload.queue }));
      },
      "run.schedule": async (payload, key) => {
        console.log(JSON.stringify({ level: "info", channel: "run.schedule", key, runAt: payload.runAt }));
      },
    },
  });

  return {
    engine,
    worker,
    dispatcher,
    store,
    routes: buildRoutes(engine),
    mode: { store: storeMode, odoo: odooMode, brain: brain.name },
    close: async () => {
      await worker.stop();
      await store.close();
    },
  };
}

/* ---------------------------------------------------------------- routing ---- */

interface Matched {
  route: Route;
  params: Record<string, string>;
}

export function matchRoute(routes: Route[], method: string, pathname: string): Matched | null {
  for (const route of routes) {
    if (route.method !== method) continue;

    const routeParts = route.path.split("/").filter(Boolean);
    const pathParts = pathname.split("/").filter(Boolean);
    if (routeParts.length !== pathParts.length) continue;

    const params: Record<string, string> = {};
    let matches = true;

    for (const [index, part] of routeParts.entries()) {
      const actual = pathParts[index] ?? "";
      if (part.startsWith(":")) {
        params[part.slice(1)] = decodeURIComponent(actual);
      } else if (part !== actual) {
        matches = false;
        break;
      }
    }

    if (matches) return { route, params };
  }
  return null;
}

/**
 * Authentication, stubbed at the boundary.
 *
 * A real deployment puts a JWT verifier or an OIDC middleware here. What must not move is
 * where the *authorisation* happens: roles are checked against the approval's own
 * requiredRoles inside the engine, at decision time, because somebody's authority can be
 * revoked between a request going out and a decision coming back.
 */
export function authenticate(headers: IncomingMessage["headers"]): AuthContext {
  const subject = (headers["x-harness-user"] as string) || "anonymous";
  const roles = ((headers["x-harness-roles"] as string) || "")
    .split(",")
    .map((role) => role.trim())
    .filter(Boolean);
  return { subject, roles };
}

export function createApiServer(harness: Harness) {
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    void handle(harness, request, response);
  });
}

async function handle(harness: Harness, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const started = Date.now();
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
      ...headers,
    });
    response.end(payload);
    console.log(
      JSON.stringify({
        level: "info",
        method: request.method,
        path: url.pathname,
        status,
        ms: Date.now() - started,
      }),
    );
  };

  if (url.pathname === "/openapi.json") {
    send(200, openApiDocument(harness.routes));
    return;
  }

  const matched = matchRoute(harness.routes, request.method ?? "GET", url.pathname);
  if (!matched) {
    const p = toProblem(new Error(`No route for ${request.method} ${url.pathname}`));
    send(404, { type: "https://harness.dev/problems/not-found", title: "Not found", status: 404 }, p.headers);
    return;
  }

  const auth = authenticate(request.headers);
  if (matched.route.roles?.length && !matched.route.roles.some((role) => auth.roles.includes(role))) {
    send(
      403,
      {
        type: "https://harness.dev/problems/forbidden",
        title: "Forbidden",
        status: 403,
        detail: `This endpoint needs one of: ${matched.route.roles.join(", ")}`,
      },
      { "content-type": "application/problem+json" },
    );
    return;
  }

  let body: unknown = undefined;
  if (request.method === "POST" || request.method === "PATCH") {
    try {
      body = await readJson(request);
    } catch {
      send(400, { title: "Body must be JSON", status: 400 });
      return;
    }
  }

  try {
    const result = await matched.route.handler({
      params: matched.params,
      query: Object.fromEntries(url.searchParams),
      body,
      auth,
    });
    send(result.status, result.body, result.headers ?? {});
  } catch (error) {
    const problem = toProblem(error);
    send(problem.status, problem.body, problem.headers ?? {});
  }
}

function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      // A body this large is not a legitimate request to this API.
      if (size > 1_000_000) {
        reject(new Error("Body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

/* ------------------------------------------------------------------- main ---- */

async function main(): Promise<void> {
  const harness = await buildHarness();
  const role = process.env.ROLE ?? "all";
  const port = Number(process.env.PORT ?? 3000);

  console.log(
    JSON.stringify({ level: "info", message: "starting", role, mode: harness.mode }),
  );

  const server = role === "worker" ? null : createApiServer(harness);
  if (server) server.listen(port, () => console.log(JSON.stringify({ level: "info", message: `listening on ${port}` })));

  if (role !== "api") {
    void harness.worker.start();
    // The dispatcher is a separate loop from the worker: delivery failures must not fail
    // the task that produced the message, and the two retry on different timescales.
    const dispatchTimer = setInterval(() => {
      void harness.dispatcher.tick().catch((error) =>
        console.error(JSON.stringify({ level: "error", message: "dispatch failed", error: String(error) })),
      );
    }, Number(process.env.DISPATCH_INTERVAL_MS ?? 1000));
    dispatchTimer.unref();
  }

  // Finish what we are holding before exiting. A worker that drops its tasks mid-flight
  // turns every deploy into a recovery event.
  const shutdown = async (signal: string) => {
    console.log(JSON.stringify({ level: "info", message: `${signal} received, draining` }));
    server?.close();
    await harness.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

// Only run when executed directly, so the tests can import buildHarness.
if (process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js")) {
  void main();
}
