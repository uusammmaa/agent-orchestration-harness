import {
  Engine,
  MemoryStore,
  OutboxDispatcher,
  Worker,
  arCollections,
  leadFollowup,
  type StoreSnapshot,
} from "@harness/core";
import { OdooClient, OdooStub, seedStub } from "@harness/odoo";
import { RulesBrain, buildHandlers } from "@harness/agents";

/**
 * The console runs the real engine, in-process, per request.
 *
 * The browser holds the store snapshot and posts it back with every action; the server
 * rehydrates a MemoryStore from it, does the work, and returns the new snapshot. On
 * serverless that is the only honest option — an in-process singleton is not reliably the
 * same process twice — and it has the useful side effect that two people looking at the
 * demo do not see each other's decisions.
 *
 * Nothing about the engine, the handlers or the Odoo client is mocked or special-cased
 * for this. The only difference from a production deployment is which store and which
 * brain got wired in, which is exactly the difference the ports exist to allow.
 */

export interface HarnessBundle {
  engine: Engine;
  store: MemoryStore;
  worker: Worker;
  dispatcher: OutboxDispatcher;
  /** Effects the dispatcher delivered during this request. */
  delivered: DeliveredEffect[];
}

export interface DeliveredEffect {
  channel: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  at: string;
}

export function buildHarness(snapshot?: StoreSnapshot): HarnessBundle {
  const store = snapshot ? MemoryStore.from(snapshot) : new MemoryStore();

  const stub = new OdooStub();
  seedStub(stub);
  const odoo = new OdooClient({
    url: "https://erp.stub",
    db: "harness",
    username: "bot@example.com",
    password: "secret",
    fetchImpl: stub.fetch,
  });

  const engine = new Engine({ store, workflows: [arCollections, leadFollowup] });
  const handlers = buildHandlers({ odoo, brain: new RulesBrain() });

  const worker = new Worker({ engine, handlers, workerId: "console", concurrency: 6, leaseMs: 60_000 });

  const delivered: DeliveredEffect[] = [];
  const record = (channel: string) => async (payload: Record<string, unknown>, idempotencyKey: string) => {
    delivered.push({ channel, idempotencyKey, payload, at: new Date().toISOString() });
  };

  const dispatcher = new OutboxDispatcher({
    engine,
    channels: {
      "email.send": record("email.send"),
      "ticket.create": record("ticket.create"),
      "run.schedule": record("run.schedule"),
    },
  });

  return { engine, store, worker, dispatcher, delivered };
}

/**
 * Drive the worker until nothing more can be leased.
 *
 * Bounded, because a request must not be able to hang: a workflow that somehow kept
 * producing ready tasks would otherwise hold the connection open until the platform
 * killed it, with no indication of why.
 */
export async function settle(bundle: HarnessBundle, maxTicks = 40): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    const leased = await bundle.worker.tick();
    await bundle.worker.drain();
    await bundle.dispatcher.tick();
    if (leased === 0) return;
  }
}

/* -------------------------------------------------------------------- seed ---- */

/**
 * The state the demo opens on.
 *
 * Four runs at four different points, because a console showing one happy run
 * demonstrates nothing. There is something waiting on a person, something that failed and
 * needs requeueing, something already finished, and something that never reached a
 * customer because the invoice was disputed.
 */
export async function seedDemo(): Promise<StoreSnapshot> {
  const bundle = buildHarness();

  // 1. Waiting on an approval — the one a reviewer should click first.
  await bundle.engine.startRun({
    workflow: "ar_collections",
    subjectId: "5001",
    input: { invoiceId: 5001 },
    labels: { customer: "Harrow & Finch Ltd", priority: "normal" },
    actor: "scheduler",
  });

  // 2. Forty days overdue with two chases already: the formal stage.
  await bundle.engine.startRun({
    workflow: "ar_collections",
    subjectId: "5002",
    input: { invoiceId: 5002 },
    labels: { customer: "Pellow Architects", priority: "high" },
    actor: "scheduler",
  });

  // 3. Disputed. Goes to a person; nothing is sent.
  await bundle.engine.startRun({
    workflow: "ar_collections",
    subjectId: "5003",
    input: { invoiceId: 5003 },
    labels: { customer: "Silverline Gin", priority: "normal" },
    actor: "scheduler",
  });

  // 4. A lead worth enough that a person reads the email before it goes.
  await bundle.engine.startRun({
    workflow: "lead_followup",
    subjectId: "7001",
    input: { leadId: 7001 },
    labels: { customer: "Calder Brewing", owner: "Nadia" },
    actor: "scheduler",
  });

  // 5. A small, confident follow-up that sends itself.
  await bundle.engine.startRun({
    workflow: "lead_followup",
    subjectId: "7002",
    input: { leadId: 7002 },
    labels: { customer: "Wren & Vale", owner: "Joel" },
    actor: "scheduler",
  });

  // 6. An invoice that does not exist, so there is a failed run to look at.
  await bundle.engine.startRun({
    workflow: "ar_collections",
    subjectId: "9999",
    input: { invoiceId: 999_999 },
    labels: { customer: "Unknown", priority: "low" },
    actor: "scheduler",
  });

  await settle(bundle);
  return bundle.store.snapshot();
}
