#!/usr/bin/env tsx
/**
 * Apply migrations from the command line.
 *
 *   npm run db:migrate
 *   npm run db:migrate -- --reset      # drop everything first; never in production
 *
 * The API migrates on boot too, so this is for a manual run or a CI step. Both go
 * through the same runner and the same advisory lock.
 */

import pg from "pg";
import { migrate, reset } from "./migrate";

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set. See .env.example.");
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: url });

  try {
    if (process.argv.includes("--reset")) {
      if (process.env.NODE_ENV === "production") {
        console.error("Refusing to --reset with NODE_ENV=production.");
        process.exit(1);
      }
      console.log("Dropping every table.");
      await reset(pool);
    }

    const result = await migrate(pool);
    if (result.applied.length === 0) {
      console.log(`Nothing to do. ${result.skipped.length} migration(s) already applied.`);
    } else {
      console.log(`Applied: ${result.applied.join(", ")}`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  } finally {
    await pool.end();
  }
}

void main();
