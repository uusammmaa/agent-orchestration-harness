/**
 * The Postgres surface, kept out of the main entry point.
 *
 * `pg` and the migration runner pull in a driver and filesystem access, neither of which
 * a browser-facing bundle has any use for. Splitting them out means the console can
 * import the engine without dragging a database driver and a `readdirSync` into a
 * serverless bundle — which is not only wasteful but makes the bundler warn, correctly,
 * that it cannot statically resolve the migrations directory.
 *
 *   import { Engine } from "@harness/core";
 *   import { PostgresStore, migrate } from "@harness/core/postgres";
 */
export { PostgresStore, type PostgresStoreOptions } from "./store/postgres";
export { migrate, loadMigrations, reset as resetDatabase, type Migration, type MigrateResult } from "./store/migrate";
