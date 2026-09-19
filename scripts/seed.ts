#!/usr/bin/env tsx
/**
 * Start a handful of runs against whatever store is configured, and let a worker settle
 * them.
 *
 *   npm run seed
 *   DATABASE_URL=... npm run seed
 *
 * Useful for filling a fresh local Postgres with something to look at, and for a quick
 * smoke test that the whole stack is wired up.
 */

import { buildHarness } from "../apps/api/src/server";

async function main(): Promise<void> {
  const harness = await buildHarness();
  console.log(`store=${harness.mode.store} odoo=${harness.mode.odoo} brain=${harness.mode.brain}`);

  const seeds = [
    { workflow: "ar_collections", subjectId: "5001", input: { invoiceId: 5001 }, labels: { customer: "Harrow & Finch Ltd" } },
    { workflow: "ar_collections", subjectId: "5002", input: { invoiceId: 5002 }, labels: { customer: "Pellow Architects" } },
    { workflow: "ar_collections", subjectId: "5003", input: { invoiceId: 5003 }, labels: { customer: "Silverline Gin" } },
    { workflow: "lead_followup", subjectId: "7001", input: { leadId: 7001 }, labels: { customer: "Calder Brewing" } },
    { workflow: "lead_followup", subjectId: "7002", input: { leadId: 7002 }, labels: { customer: "Wren & Vale" } },
  ];

  for (const seed of seeds) {
    const run = await harness.engine.startRun({
      ...seed,
      // Keyed on the day, so re-running the seed does not pile up duplicate runs.
      idempotencyKey: `seed:${seed.workflow}:${seed.subjectId}:${new Date().toISOString().slice(0, 10)}`,
      actor: "seed-script",
    });
    console.log(`${run.id}  ${run.workflow}  ${run.subjectId}`);
  }

  // Settle whatever can be settled, so the console has something to show immediately.
  for (let i = 0; i < 40; i++) {
    const leased = await harness.worker.tick();
    await harness.worker.drain();
    await harness.dispatcher.tick();
    if (leased === 0) break;
  }

  const stats = await harness.engine.store.reads.stats();
  console.log("");
  console.log(`runs      ${JSON.stringify(stats.runsByStatus)}`);
  console.log(`approvals ${stats.pendingApprovals} waiting on a person`);
  console.log(`outbox    ${stats.outboxPending} pending, ${stats.outboxFailed} abandoned`);

  await harness.close();
}

void main();
