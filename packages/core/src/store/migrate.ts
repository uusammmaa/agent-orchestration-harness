import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool, PoolClient } from "pg";

/**
 * Migration runner.
 *
 * Deliberately small and dependency-free. It does three things a hand-rolled runner
 * usually gets wrong:
 *
 *  - **One advisory lock for the whole run.** Two API instances starting at once will
 *    both try to migrate; one waits rather than both applying `0001` concurrently.
 *  - **Each migration in its own transaction**, so a failure leaves the applied ones
 *    applied and the rest untouched, and the next attempt carries on from there.
 *  - **A checksum per file.** Editing a migration that has already run is the single most
 *    common way a team ends up with two different schemas, so it is refused rather than
 *    silently ignored.
 */

const LOCK_KEY = 0x48_41_52_4e; // "HARN"

export interface Migration {
  name: string;
  sql: string;
  checksum: string;
}

export function loadMigrations(directory?: string): Migration[] {
  const dir = directory ?? join(dirname(fileURLToPath(import.meta.url)), "migrations");
  return readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => {
      const sql = readFileSync(join(dir, file), "utf8");
      return { name: file, sql, checksum: checksum(sql) };
    });
}

/** FNV-1a. Not cryptographic — this detects edits, not attacks. */
function checksum(text: string): string {
  let hash = 0x811c9dc5;
  // Normalise line endings so a checkout on Windows does not look like an edit.
  for (const char of text.replace(/\r\n/g, "\n")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

export async function migrate(pool: Pool, directory?: string): Promise<MigrateResult> {
  const migrations = loadMigrations(directory);
  const client = await pool.connect();
  const result: MigrateResult = { applied: [], skipped: [] };

  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS harness_migrations (
        name       TEXT PRIMARY KEY,
        checksum   TEXT        NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query<{ name: string; checksum: string }>(
      "SELECT name, checksum FROM harness_migrations",
    );
    const applied = new Map(rows.map((row) => [row.name, row.checksum]));

    for (const migration of migrations) {
      const previous = applied.get(migration.name);
      if (previous) {
        if (previous !== migration.checksum) {
          throw new Error(
            `${migration.name} has changed since it was applied (${previous} -> ${migration.checksum}). ` +
              `Add a new migration instead of editing one that has run.`,
          );
        }
        result.skipped.push(migration.name);
        continue;
      }

      await withTransaction(client, async () => {
        await client.query(migration.sql);
        await client.query("INSERT INTO harness_migrations (name, checksum) VALUES ($1, $2)", [
          migration.name,
          migration.checksum,
        ]);
      });
      result.applied.push(migration.name);
    }

    return result;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}

/** Drop everything. For tests and local resets; never call it against production. */
export async function reset(pool: Pool): Promise<void> {
  await pool.query(`
    DROP TABLE IF EXISTS outbox, events, approvals, task_attempts, tasks, runs, harness_migrations CASCADE;
    DROP FUNCTION IF EXISTS harness_touch_updated_at CASCADE;
    DROP FUNCTION IF EXISTS harness_guard_run_transition CASCADE;
    DROP FUNCTION IF EXISTS harness_guard_task_transition CASCADE;
    DROP FUNCTION IF EXISTS harness_guard_approval CASCADE;
    DROP FUNCTION IF EXISTS harness_events_append_only CASCADE;
    DROP FUNCTION IF EXISTS harness_run_transition_ok CASCADE;
    DROP FUNCTION IF EXISTS harness_task_transition_ok CASCADE;
  `);
}

async function withTransaction(client: PoolClient, fn: () => Promise<void>): Promise<void> {
  await client.query("BEGIN");
  try {
    await fn();
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
