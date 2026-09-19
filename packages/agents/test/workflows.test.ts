import { beforeEach, describe, expect, it } from "vitest";
import {
  Engine,
  MemoryStore,
  OutboxDispatcher,
  Worker,
  arCollections,
  leadFollowup,
  stageFor,
  type Run,
} from "@harness/core";
import { OdooClient, OdooStub, seedStub } from "@harness/odoo";
import { RulesBrain } from "../src/rules-brain";
import { buildHandlers } from "../src/handlers";

/**
 * The whole thing, end to end.
 *
 * Real engine, real handlers, real XML-RPC against a stub Odoo, real outbox dispatch.
 * The only thing standing in for production is the brain, and it implements the same
 * contract the model one does.
 *
 * These are the tests that would catch a regression nobody else would: the store tests
 * prove leasing works and the engine tests prove approvals suspend a run, but only this
 * file proves that chasing an invoice actually stops at a human and that a disputed
 * invoice never reaches a customer.
 */

const TODAY = new Date("2026-09-19T09:00:00.000Z");

function harness() {
  const stub = new OdooStub();
  seedStub(stub, TODAY);

  const odoo = new OdooClient({
    url: "https://erp.example",
    db: "harness",
    username: "bot@example.com",
    password: "secret",
    fetchImpl: stub.fetch,
  });

  const store = new MemoryStore();
  let clock = TODAY;
  let ids = 0;

  const engine = new Engine({
    store,
    workflows: [arCollections, leadFollowup],
    now: () => clock,
    idFactory: (prefix) => `${prefix}_${String(++ids).padStart(4, "0")}`,
    backoff: () => 0,
  });

  const handlers = buildHandlers({ odoo, brain: new RulesBrain(), now: () => clock });
  const worker = new Worker({ engine, handlers, workerId: "w1", concurrency: 4, leaseMs: 60_000 });

  const delivered: Array<{ channel: string; payload: Record<string, unknown>; key: string }> = [];
  const dispatcher = new OutboxDispatcher({
    engine,
    channels: {
      "email.send": async (payload, key) => void delivered.push({ channel: "email.send", payload, key }),
      "ticket.create": async (payload, key) => void delivered.push({ channel: "ticket.create", payload, key }),
      "run.schedule": async (payload, key) => void delivered.push({ channel: "run.schedule", payload, key }),
    },
  });

  return {
    stub,
    odoo,
    store,
    engine,
    worker,
    dispatcher,
    delivered,
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
    /**
     * Drive the worker until nothing more can be leased, without dispatching.
     *
     * The dispatcher tests need the outbox populated but not yet delivered, which the
     * combined `drain()` cannot give them.
     */
    async workerOnly(maxTicks = 40) {
      for (let i = 0; i < maxTicks; i++) {
        const leased = await this.worker.tick();
        await this.worker.drain();
        if (leased === 0) return;
      }
      throw new Error("the run did not settle");
    },
    /** Drive the worker until nothing more can be leased. */
    async drain(maxTicks = 40) {
      for (let i = 0; i < maxTicks; i++) {
        const leased = await this.worker.tick();
        // drain, not stop: stopping is one-way, so a stopped worker leases nothing more.
        await this.worker.drain();
        await this.dispatcher.tick(clock);
        if (leased === 0) return;
      }
      throw new Error("the run did not settle");
    },
  };
}

async function tasksOf(h: ReturnType<typeof harness>, run: Run) {
  const tasks = await h.store.reads.listTasks(run.id);
  return Object.fromEntries(tasks.map((task) => [task.key, task]));
}

describe("the dunning ladder", () => {
  it("never goes backwards, however the dates look", () => {
    // Eight days overdue is stage 1 by age, but two reminders have already gone out.
    expect(stageFor(8, 2).stage).toBe(3);
    expect(stageFor(65, 0).stage).toBe(4);
    expect(stageFor(1, 0).stage).toBe(1);
  });
});

describe("ar_collections", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it("stops at the approval gate and sends nothing", async () => {
    const run = await h.engine.startRun({
      workflow: "ar_collections",
      subjectId: "5001",
      input: { invoiceId: 5001 },
    });

    await h.drain();

    const current = await h.store.reads.getRun(run.id);
    expect(current?.status).toBe("waiting_approval");

    const tasks = await tasksOf(h, run);
    expect(tasks.fetch_invoice?.status).toBe("succeeded");
    expect(tasks.draft_message?.status).toBe("succeeded");
    expect(tasks.approve_message?.status).toBe("waiting_approval");
    expect(tasks.send_message?.status).toBe("pending");

    // The whole point: nothing has reached the customer.
    expect(h.delivered.filter((message) => message.channel === "email.send")).toHaveLength(0);
  });

  it("puts a real draft in front of the approver", async () => {
    const run = await h.engine.startRun({ workflow: "ar_collections", subjectId: "5001", input: { invoiceId: 5001 } });
    await h.drain();

    const approvals = await h.store.reads.listApprovals({ runId: run.id });
    const approval = approvals.items[0];

    expect(approval?.status).toBe("pending");
    expect(approval?.summary).toMatch(/Harrow & Finch/);
    expect(String(approval?.payload.body)).toContain("INV/2026/0417");
    // The figure must be the invoice's, not one the agent invented.
    expect(String(approval?.payload.body)).toContain("4,250");
  });

  it("sends and logs back to Odoo once approved", async () => {
    const run = await h.engine.startRun({ workflow: "ar_collections", subjectId: "5001", input: { invoiceId: 5001 } });
    await h.drain();

    const approvals = await h.store.reads.listApprovals({ runId: run.id });
    await h.engine.decideApproval({
      approvalId: approvals.items[0]!.id,
      decision: "approved",
      decidedBy: "ana",
      roles: ["ar_manager"],
      note: "Fine to send",
    });

    await h.drain();

    const emails = h.delivered.filter((message) => message.channel === "email.send");
    expect(emails).toHaveLength(1);
    expect(emails[0]?.payload.to).toBe("ap@harrowfinch.example");

    // Odoo has been told, so a human looking at the invoice can see the chase.
    const notes = h.stub.records("mail.message").filter((record) => record.res_id === 5001);
    expect(notes.some((note) => String(note.subject).includes("Reminder sent"))).toBe(true);

    expect((await h.store.reads.getRun(run.id))?.status).toBe("succeeded");
  });

  it("sends nothing when the approval is rejected", async () => {
    const run = await h.engine.startRun({ workflow: "ar_collections", subjectId: "5001", input: { invoiceId: 5001 } });
    await h.drain();

    const approvals = await h.store.reads.listApprovals({ runId: run.id });
    await h.engine.decideApproval({
      approvalId: approvals.items[0]!.id,
      decision: "rejected",
      decidedBy: "ana",
      roles: ["ar_manager"],
      note: "They rang this morning, payment is on its way",
    });

    await h.drain();
    expect(h.delivered.filter((message) => message.channel === "email.send")).toHaveLength(0);

    // And the reason is on the record.
    const events = await h.store.reads.listEvents(run.id);
    const rejection = events.find((event) => event.type === "approval.rejected");
    expect(rejection?.payload.note).toMatch(/payment is on its way/);
  });

  it("sends nothing when nobody approves in time", async () => {
    const run = await h.engine.startRun({ workflow: "ar_collections", subjectId: "5001", input: { invoiceId: 5001 } });
    await h.drain();

    h.advance(49 * 3_600_000);
    await h.engine.expireApprovals();
    await h.drain();

    expect(h.delivered.filter((message) => message.channel === "email.send")).toHaveLength(0);
    const tasks = await tasksOf(h, run);
    expect(tasks.approve_message?.status).toBe("skipped");
  });

  it("routes a disputed invoice to a person instead of chasing it", async () => {
    const run = await h.engine.startRun({ workflow: "ar_collections", subjectId: "5003", input: { invoiceId: 5003 } });
    await h.drain();

    const tasks = await tasksOf(h, run);
    expect(tasks.route_dispute?.status).toBe("succeeded");
    expect(tasks.draft_message?.status).toBe("skipped");
    expect(tasks.approve_message?.status).toBe("skipped");

    expect(h.delivered.filter((message) => message.channel === "email.send")).toHaveLength(0);
    expect(h.delivered.filter((message) => message.channel === "ticket.create")).toHaveLength(1);
  });

  it("escalates a customer who has already been chased twice", async () => {
    const run = await h.engine.startRun({ workflow: "ar_collections", subjectId: "5002", input: { invoiceId: 5002 } });
    await h.drain();

    const approvals = await h.store.reads.listApprovals({ runId: run.id });
    // Forty days overdue with two prior reminders: stage 3, a formal letter.
    expect(approvals.items[0]?.summary).toMatch(/formal/);
  });

  it("does not chase the same invoice twice from one trigger", async () => {
    const first = await h.engine.startRun({
      workflow: "ar_collections",
      subjectId: "5001",
      input: { invoiceId: 5001 },
      idempotencyKey: "inv-5001-2026-09-19",
    });
    const second = await h.engine.startRun({
      workflow: "ar_collections",
      subjectId: "5001",
      input: { invoiceId: 5001 },
      idempotencyKey: "inv-5001-2026-09-19",
    });

    expect(second.id).toBe(first.id);
    expect((await h.store.reads.listRuns({})).items).toHaveLength(1);
  });

  it("recovers when Odoo is briefly unavailable", async () => {
    h.stub.failNext = 1;
    h.stub.failWith = { code: 3, message: "Access Denied: session expired" };

    const run = await h.engine.startRun({ workflow: "ar_collections", subjectId: "5001", input: { invoiceId: 5001 } });
    await h.drain();

    const tasks = await tasksOf(h, run);
    expect(tasks.fetch_invoice?.status).toBe("succeeded");
    // The failure is on the record even though the run recovered.
    expect(tasks.fetch_invoice?.attempt).toBeGreaterThan(1);

    const attempts = await h.store.reads.listAttempts(tasks.fetch_invoice!.id);
    expect(attempts[0]?.outcome).toBe("failed");
    expect(attempts.at(-1)?.outcome).toBe("succeeded");
  });

  it("gives up on an invoice that does not exist, without retrying", async () => {
    const run = await h.engine.startRun({
      workflow: "ar_collections",
      subjectId: "999999",
      input: { invoiceId: 999_999 },
    });
    await h.drain();

    const tasks = await tasksOf(h, run);
    expect(tasks.fetch_invoice?.status).toBe("failed");
    // Permanent means one attempt, not three.
    expect(tasks.fetch_invoice?.attempt).toBe(1);
    expect((await h.store.reads.getRun(run.id))?.status).toBe("failed");
  });

  it("delivers each effect exactly once, whatever the dispatcher does", async () => {
    const run = await h.engine.startRun({ workflow: "ar_collections", subjectId: "5001", input: { invoiceId: 5001 } });
    await h.drain();

    const approvals = await h.store.reads.listApprovals({ runId: run.id });
    await h.engine.decideApproval({
      approvalId: approvals.items[0]!.id,
      decision: "approved",
      decidedBy: "ana",
      roles: ["ar_manager"],
    });
    await h.drain();

    // Run the dispatcher again: a delivered message must not go out twice.
    await h.dispatcher.tick(TODAY);
    await h.dispatcher.tick(TODAY);

    expect(h.delivered.filter((message) => message.channel === "email.send")).toHaveLength(1);
  });
});

describe("lead_followup", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it("asks a person about a high-value lead", async () => {
    // Calder Brewing, £42,000 — over the review threshold.
    const run = await h.engine.startRun({ workflow: "lead_followup", subjectId: "7001", input: { leadId: 7001 } });
    await h.drain();

    expect((await h.store.reads.getRun(run.id))?.status).toBe("waiting_approval");
    const approvals = await h.store.reads.listApprovals({ runId: run.id });
    expect(approvals.items[0]?.summary).toMatch(/42,000 opportunity/);
    expect(h.delivered.filter((message) => message.channel === "email.send")).toHaveLength(0);
  });

  it("sends a small, clear-cut follow-up without asking anyone", async () => {
    // Wren & Vale, £6,500 — under the threshold, and the agent is confident.
    const run = await h.engine.startRun({ workflow: "lead_followup", subjectId: "7002", input: { leadId: 7002 } });
    await h.drain();

    const tasks = await tasksOf(h, run);
    expect(tasks.review_outreach?.status).toBe("skipped");
    expect(tasks.send_outreach?.status).toBe("succeeded");

    const emails = h.delivered.filter((message) => message.channel === "email.send");
    expect(emails).toHaveLength(1);
    expect(emails[0]?.payload.to).toBe("hello@wrenvale.example");
  });

  it("never contacts a lead whose address has bounced", async () => {
    // Hollis Foods has three bounces on record.
    const run = await h.engine.startRun({ workflow: "lead_followup", subjectId: "7003", input: { leadId: 7003 } });
    await h.drain();

    const tasks = await tasksOf(h, run);
    expect(tasks.qualify?.status).toBe("skipped");
    expect(h.delivered.filter((message) => message.channel === "email.send")).toHaveLength(0);
  });

  it("stops approaching a lead that has never replied", async () => {
    h.stub.seed("mail.message", [
      { id: 9101, model: "crm.lead", res_id: 7002, message_type: "email" },
      { id: 9102, model: "crm.lead", res_id: 7002, message_type: "email" },
      { id: 9103, model: "crm.lead", res_id: 7002, message_type: "email" },
      { id: 9104, model: "crm.lead", res_id: 7002, message_type: "email" },
    ]);

    const run = await h.engine.startRun({ workflow: "lead_followup", subjectId: "7002", input: { leadId: 7002 } });
    await h.drain();

    const tasks = await tasksOf(h, run);
    expect(tasks.qualify?.status).toBe("skipped");
    expect(tasks.mark_exhausted?.status).toBe("succeeded");
    expect(h.delivered.filter((message) => message.channel === "email.send")).toHaveLength(0);
  });
});

describe("the worker", () => {
  it("does not lose a task when a handler throws something unexpected", async () => {
    const h = harness();
    const engine = h.engine;

    const worker = new Worker({
      engine,
      handlers: {
        "odoo.fetch_invoice": async () => {
          throw new TypeError("undefined is not a function");
        },
      },
      workerId: "broken",
      leaseMs: 60_000,
    });

    const run = await engine.startRun({ workflow: "ar_collections", subjectId: "5001", input: { invoiceId: 5001 } });
    await worker.tick();
    await worker.drain();

    const tasks = await tasksOf(h, run);
    // An unrecognised throw is permanent: it failed, it did not silently vanish.
    expect(tasks.fetch_invoice?.status).toBe("failed");
    expect(tasks.fetch_invoice?.error?.code).toBe("handler.unknown");
  });

  it("fails a task whose handler is not registered, rather than leaving it leased", async () => {
    const h = harness();
    const worker = new Worker({ engine: h.engine, handlers: {}, workerId: "empty", leaseMs: 60_000 });

    const run = await h.engine.startRun({ workflow: "ar_collections", subjectId: "5001", input: { invoiceId: 5001 } });
    await worker.tick();
    await worker.drain();

    const tasks = await tasksOf(h, run);
    expect(tasks.fetch_invoice?.error?.code).toBe("worker.no_handler");
  });
});

describe("the outbox dispatcher", () => {
  it("retries a failing channel and eventually abandons it", async () => {
    const h = harness();
    let attempts = 0;

    const dispatcher = new OutboxDispatcher({
      engine: h.engine,
      channels: {
        "email.send": async () => {
          attempts++;
          throw new Error("SMTP unavailable");
        },
      },
      backoff: () => 0,
    });

    const run = await h.engine.startRun({ workflow: "ar_collections", subjectId: "5001", input: { invoiceId: 5001 } });
    await h.workerOnly();
    const approvals = await h.store.reads.listApprovals({ runId: run.id });
    await h.engine.decideApproval({
      approvalId: approvals.items[0]!.id,
      decision: "approved",
      decidedBy: "ana",
      roles: ["ar_manager"],
    });
    await h.workerOnly();

    for (let i = 0; i < 6; i++) await dispatcher.tick(TODAY);

    expect(attempts).toBe(5);

    // The run also queues a follow-up on a channel this dispatcher does not have, which
    // is abandoned too. Filter to the one under test.
    const abandoned = await h.store.reads.listOutbox({ status: "abandoned" });
    const email = abandoned.filter((message) => message.channel === "email.send");
    expect(email).toHaveLength(1);
    expect(email[0]?.lastError).toMatch(/SMTP unavailable/);
    expect(email[0]?.attempts).toBe(5);
  });

  it("abandons a message with no channel rather than retrying forever", async () => {
    const h = harness();
    const dispatcher = new OutboxDispatcher({ engine: h.engine, channels: {}, backoff: () => 0 });

    const run = await h.engine.startRun({ workflow: "ar_collections", subjectId: "5003", input: { invoiceId: 5003 } });
    await h.workerOnly();

    for (let i = 0; i < 6; i++) await dispatcher.tick(TODAY);

    const abandoned = await h.store.reads.listOutbox({ status: "abandoned" });
    expect(abandoned.length).toBeGreaterThan(0);
    expect(abandoned[0]?.lastError).toMatch(/No channel/);
    expect(run.id).toBeTruthy();
  });
});
