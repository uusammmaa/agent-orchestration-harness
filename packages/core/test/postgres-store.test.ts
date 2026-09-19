import { describe, it } from "vitest";
import { PostgresStore } from "../src/store/postgres";
import { migrate, reset } from "../src/store/migrate";
import { runStoreContract } from "./store-contract";

/**
 * The same contract, against real Postgres.
 *
 * Skipped unless HARNESS_TEST_POSTGRES is set, so `npm test` stays fast and works without
 * Docker. CI runs it with a service container; `npm run test:pg` runs it locally.
 *
 * This is the suite that matters. The in-memory store is only trustworthy because these
 * two files run the same assertions.
 */

const url = process.env.DATABASE_URL ?? "postgres://harness:harness@127.0.0.1:55432/harness";
const enabled = process.env.HARNESS_TEST_POSTGRES === "1";

if (enabled) {
  let store: PostgresStore | null = null;

  runStoreContract({
    name: "PostgresStore",
    async create() {
      store = new PostgresStore({ connectionString: url });
      await migrate(store.rawPool);
      return store;
    },
    async reset() {
      if (!store) return;
      // TRUNCATE rather than drop and re-migrate: two orders of magnitude faster, and the
      // cascade covers every table because they all hang off runs.
      await store.rawPool.query("TRUNCATE runs, tasks, task_attempts, approvals, events, outbox CASCADE");
    },
  });
} else {
  describe("store contract: PostgresStore", () => {
    it.skip("skipped - set HARNESS_TEST_POSTGRES=1 to run against a real database", () => undefined);
  });
}

export { reset };
