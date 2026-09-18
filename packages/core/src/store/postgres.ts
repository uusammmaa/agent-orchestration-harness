import pg from "pg";
import type { Approval, Event, OutboxMessage, Run, Task, TaskAttempt } from "../domain/types";
import {
  NotFoundError,
  VersionConflictError,
  type ApprovalFilter,
  type ApprovalPatch,
  type HarnessStats,
  type LeaseParams,
  type OutboxPatch,
  type Page,
  type RunFilter,
  type RunPatch,
  type Store,
  type StoreTx,
  type TaskPatch,
} from "./port";

const { Pool } = pg;
type PoolClient = pg.PoolClient;

/**
 * Postgres store.
 *
 * The two methods worth reading are `leaseTasks` and `reclaimExpiredLeases`. Everything
 * else is mapping rows to objects; those two are where the concurrency guarantees live.
 *
 * `pg` returns `numeric` as a string to avoid precision loss, and `bigint` likewise. This
 * schema uses `integer` for every number that reaches JavaScript, so no parsers are
 * overridden — a global `pg.types.setTypeParser` would change behaviour for every other
 * consumer of the same process, which is a rude thing for a library to do.
 */

export interface PostgresStoreOptions {
  connectionString: string;
  /** Kept small on purpose: serverless callers should use a pooler, not a big pool. */
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  /** Supply `ssl: { rejectUnauthorized: false }` for hosted Postgres with a self-signed cert. */
  ssl?: pg.PoolConfig["ssl"];
}

export class PostgresStore implements Store {
  private readonly pool: pg.Pool;
  /** Tracks the client of an in-flight transaction so nested calls join it. */
  private readonly depth = new WeakMap<object, number>();

  constructor(options: PostgresStoreOptions) {
    this.pool = new Pool({
      connectionString: options.connectionString,
      max: options.max ?? 10,
      idleTimeoutMillis: options.idleTimeoutMillis ?? 30_000,
      connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5_000,
      ...(options.ssl !== undefined ? { ssl: options.ssl } : {}),
    });
  }

  /** Exposed so the migration runner and tests can use the same pool. */
  get rawPool(): pg.Pool {
    return this.pool;
  }

  get reads(): StoreTx {
    return new PgTx(this.pool);
  }

  async transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const tx = new PgTx(client);
      const result = await fn(tx);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

type Queryable = Pick<pg.Pool, "query"> | Pick<PoolClient, "query">;

class PgTx implements StoreTx {
  constructor(private readonly db: Queryable) {}

  private async query<T extends pg.QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
    const result = await (this.db as pg.Pool).query<T>(text, values as never[]);
    return result.rows;
  }

  private async one<T extends pg.QueryResultRow>(text: string, values: unknown[] = []): Promise<T | null> {
    const rows = await this.query<T>(text, values);
    return rows[0] ?? null;
  }

  /* ------------------------------------------------------------------ runs -- */

  async getRun(id: string): Promise<Run | null> {
    const row = await this.one<RunRow>("SELECT * FROM runs WHERE id = $1", [id]);
    return row ? toRun(row) : null;
  }

  async getRunByIdempotencyKey(workflow: string, key: string): Promise<Run | null> {
    const row = await this.one<RunRow>("SELECT * FROM runs WHERE workflow = $1 AND idempotency_key = $2", [
      workflow,
      key,
    ]);
    return row ? toRun(row) : null;
  }

  async listRuns(filter: RunFilter): Promise<Page<Run>> {
    const where: string[] = [];
    const values: unknown[] = [];

    if (filter.status?.length) {
      values.push(filter.status);
      where.push(`status = ANY($${values.length})`);
    }
    if (filter.workflow) {
      values.push(filter.workflow);
      where.push(`workflow = $${values.length}`);
    }
    if (filter.subjectId) {
      values.push(filter.subjectId);
      where.push(`subject_id = $${values.length}`);
    }
    if (filter.label) {
      values.push(JSON.stringify({ [filter.label.key]: filter.label.value }));
      where.push(`labels @> $${values.length}::jsonb`);
    }
    if (filter.cursor) {
      // Keyset pagination on (created_at, id), which is stable under concurrent inserts
      // in a way that OFFSET is not.
      values.push(filter.cursor);
      where.push(
        `(created_at, id) < (SELECT created_at, id FROM runs WHERE id = $${values.length})`,
      );
    }

    const limit = filter.limit ?? 50;
    values.push(limit + 1);

    const rows = await this.query<RunRow>(
      `SELECT * FROM runs
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY created_at DESC, id DESC
       LIMIT $${values.length}`,
      values,
    );

    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(toRun);
    return { items, nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null };
  }

  async insertRun(run: Run): Promise<Run> {
    // ON CONFLICT makes the idempotency guarantee the database's, not the caller's. Two
    // concurrent inserts with the same key cannot both win.
    const row = await this.one<RunRow>(
      `INSERT INTO runs (id, workflow, workflow_version, status, subject_type, subject_id,
                         input, context, idempotency_key, version, created_at, updated_at,
                         started_at, finished_at, error, labels)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (workflow, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING *`,
      [
        run.id,
        run.workflow,
        run.workflowVersion,
        run.status,
        run.subjectType,
        run.subjectId,
        JSON.stringify(run.input),
        JSON.stringify(run.context),
        run.idempotencyKey,
        run.version,
        run.createdAt,
        run.updatedAt,
        run.startedAt,
        run.finishedAt,
        run.error ? JSON.stringify(run.error) : null,
        JSON.stringify(run.labels),
      ],
    );

    if (row) return toRun(row);

    // The conflict fired: somebody else got there first, so return theirs.
    const existing = run.idempotencyKey ? await this.getRunByIdempotencyKey(run.workflow, run.idempotencyKey) : null;
    if (!existing) throw new Error(`Failed to insert run ${run.id} and no conflicting row was found`);
    return existing;
  }

  async updateRun(id: string, expectedVersion: number, patch: RunPatch): Promise<Run> {
    const { sets, values } = buildPatch(
      {
        status: patch.status,
        context: patch.context !== undefined ? JSON.stringify(patch.context) : undefined,
        started_at: patch.startedAt,
        finished_at: patch.finishedAt,
        error: patch.error !== undefined ? (patch.error ? JSON.stringify(patch.error) : null) : undefined,
        labels: patch.labels !== undefined ? JSON.stringify(patch.labels) : undefined,
      },
      [id, expectedVersion],
    );

    const row = await this.one<RunRow>(
      `UPDATE runs SET ${sets.join(", ")}, version = version + 1
       WHERE id = $1 AND version = $2 RETURNING *`,
      values,
    );
    if (row) return toRun(row);

    return this.explainMissedUpdate("run", id, expectedVersion);
  }

  /* ----------------------------------------------------------------- tasks -- */

  async getTask(id: string): Promise<Task | null> {
    const row = await this.one<TaskRow>("SELECT * FROM tasks WHERE id = $1", [id]);
    return row ? toTask(row) : null;
  }

  async listTasks(runId: string): Promise<Task[]> {
    const rows = await this.query<TaskRow>("SELECT * FROM tasks WHERE run_id = $1 ORDER BY created_at, id", [runId]);
    return rows.map(toTask);
  }

  async insertTasks(tasks: Task[]): Promise<Task[]> {
    if (tasks.length === 0) return [];

    // One multi-row insert rather than N round trips. With a dozen tasks per run that is
    // the difference between one network hop and twelve.
    const columns = 17;
    const placeholders = tasks
      .map((_, index) => `(${Array.from({ length: columns }, (_, i) => `$${index * columns + i + 1}`).join(",")})`)
      .join(",");

    const values = tasks.flatMap((task) => [
      task.id,
      task.runId,
      task.key,
      task.handler,
      task.status,
      task.dependsOn,
      JSON.stringify(task.input),
      task.output ? JSON.stringify(task.output) : null,
      task.attempt,
      task.maxAttempts,
      task.leasedBy,
      task.leaseExpiresAt,
      task.runAfter,
      task.approvalId,
      task.version,
      task.createdAt,
      task.updatedAt,
    ]);

    const rows = await this.query<TaskRow>(
      `INSERT INTO tasks (id, run_id, key, handler, status, depends_on, input, output, attempt,
                          max_attempts, leased_by, lease_expires_at, run_after, approval_id,
                          version, created_at, updated_at)
       VALUES ${placeholders} RETURNING *`,
      values,
    );
    return rows.map(toTask);
  }

  async updateTask(id: string, expectedVersion: number, patch: TaskPatch): Promise<Task> {
    const { sets, values } = buildPatch(
      {
        status: patch.status,
        output: patch.output !== undefined ? (patch.output ? JSON.stringify(patch.output) : null) : undefined,
        attempt: patch.attempt,
        leased_by: patch.leasedBy,
        lease_expires_at: patch.leaseExpiresAt,
        run_after: patch.runAfter,
        approval_id: patch.approvalId,
        finished_at: patch.finishedAt,
        error: patch.error !== undefined ? (patch.error ? JSON.stringify(patch.error) : null) : undefined,
        input: (patch as { input?: Record<string, unknown> }).input
          ? JSON.stringify((patch as { input?: Record<string, unknown> }).input)
          : undefined,
      },
      [id, expectedVersion],
    );

    const row = await this.one<TaskRow>(
      `UPDATE tasks SET ${sets.join(", ")}, version = version + 1
       WHERE id = $1 AND version = $2 RETURNING *`,
      values,
    );
    if (row) return toTask(row);

    return this.explainMissedUpdate("task", id, expectedVersion);
  }

  /**
   * Claim ready tasks.
   *
   * `FOR UPDATE SKIP LOCKED` is the whole point: each worker takes rows nobody else has
   * locked and moves on rather than queueing behind them. Ten workers polling the same
   * table therefore do useful work instead of taking turns.
   *
   * It is one statement, so the select and the update cannot be interleaved by another
   * worker. Splitting them is the classic way to hand the same task to two workers.
   */
  async leaseTasks(params: LeaseParams): Promise<Task[]> {
    const handlerFilter = params.handlers?.length ? "AND handler = ANY($4)" : "";
    const values: unknown[] = [
      params.now,
      params.limit,
      new Date(params.now.getTime() + params.leaseMs),
      ...(params.handlers?.length ? [params.handlers] : []),
    ];
    const workerIndex = values.length + 1;
    values.push(params.workerId);

    const rows = await this.query<TaskRow>(
      `WITH claimed AS (
         SELECT id FROM tasks
         WHERE status = 'ready'
           AND (run_after IS NULL OR run_after <= $1)
           ${handlerFilter}
         ORDER BY run_after NULLS FIRST, created_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       UPDATE tasks t
       SET status = 'leased',
           leased_by = $${workerIndex},
           lease_expires_at = $3,
           attempt = t.attempt + 1,
           version = t.version + 1
       FROM claimed
       WHERE t.id = claimed.id
       RETURNING t.*`,
      values,
    );
    return rows.map(toTask);
  }

  async reclaimExpiredLeases(now: Date, limit: number): Promise<Task[]> {
    const rows = await this.query<TaskRow>(
      `WITH expired AS (
         SELECT id FROM tasks
         WHERE status = 'leased' AND lease_expires_at <= $1
         ORDER BY lease_expires_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       UPDATE tasks t
       SET status = 'ready', leased_by = NULL, lease_expires_at = NULL, version = t.version + 1
       FROM expired
       WHERE t.id = expired.id
       RETURNING t.*`,
      [now, limit],
    );
    return rows.map(toTask);
  }

  /* -------------------------------------------------------------- attempts -- */

  async listAttempts(taskId: string): Promise<TaskAttempt[]> {
    const rows = await this.query<AttemptRow>(
      "SELECT * FROM task_attempts WHERE task_id = $1 ORDER BY attempt",
      [taskId],
    );
    return rows.map(toAttempt);
  }

  async insertAttempt(attempt: TaskAttempt): Promise<TaskAttempt> {
    const row = await this.one<AttemptRow>(
      `INSERT INTO task_attempts (id, task_id, run_id, attempt, worker_id, started_at,
                                  finished_at, outcome, error, duration_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       -- A reclaimed task keeps its attempt number, so the retry collides with the row
       -- from the worker that died. The newer worker owns it.
       ON CONFLICT (task_id, attempt) DO UPDATE
         SET worker_id = EXCLUDED.worker_id, started_at = EXCLUDED.started_at,
             finished_at = NULL, outcome = NULL, error = NULL, duration_ms = NULL
       RETURNING *`,
      [
        attempt.id,
        attempt.taskId,
        attempt.runId,
        attempt.attempt,
        attempt.workerId,
        attempt.startedAt,
        attempt.finishedAt,
        attempt.outcome,
        attempt.error ? JSON.stringify(attempt.error) : null,
        attempt.durationMs,
      ],
    );
    if (!row) throw new Error(`Failed to record attempt ${attempt.attempt} of task ${attempt.taskId}`);
    return toAttempt(row);
  }

  async finishAttempt(
    id: string,
    patch: Pick<TaskAttempt, "finishedAt" | "outcome" | "error" | "durationMs">,
  ): Promise<TaskAttempt> {
    const row = await this.one<AttemptRow>(
      `UPDATE task_attempts
       SET finished_at = $2, outcome = $3, error = $4, duration_ms = $5
       WHERE id = $1 RETURNING *`,
      [id, patch.finishedAt, patch.outcome, patch.error ? JSON.stringify(patch.error) : null, patch.durationMs],
    );
    if (!row) throw new NotFoundError("attempt", id);
    return toAttempt(row);
  }

  /* ------------------------------------------------------------- approvals -- */

  async getApproval(id: string): Promise<Approval | null> {
    const row = await this.one<ApprovalRow>("SELECT * FROM approvals WHERE id = $1", [id]);
    return row ? toApproval(row) : null;
  }

  async listApprovals(filter: ApprovalFilter): Promise<Page<Approval>> {
    const where: string[] = [];
    const values: unknown[] = [];

    if (filter.status?.length) {
      values.push(filter.status);
      where.push(`status = ANY($${values.length})`);
    }
    if (filter.runId) {
      values.push(filter.runId);
      where.push(`run_id = $${values.length}`);
    }
    if (filter.cursor) {
      values.push(filter.cursor);
      where.push(`(requested_at, id) > (SELECT requested_at, id FROM approvals WHERE id = $${values.length})`);
    }

    const limit = filter.limit ?? 50;
    values.push(limit + 1);

    const rows = await this.query<ApprovalRow>(
      `SELECT * FROM approvals
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY requested_at, id
       LIMIT $${values.length}`,
      values,
    );

    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(toApproval);
    return { items, nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null };
  }

  async insertApproval(approval: Approval): Promise<Approval> {
    const row = await this.one<ApprovalRow>(
      `INSERT INTO approvals (id, run_id, task_id, summary, payload, required_roles, status,
                              requested_at, expires_at, decided_at, decided_by, decision_note,
                              edited_payload, version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [
        approval.id,
        approval.runId,
        approval.taskId,
        approval.summary,
        JSON.stringify(approval.payload),
        approval.requiredRoles,
        approval.status,
        approval.requestedAt,
        approval.expiresAt,
        approval.decidedAt,
        approval.decidedBy,
        approval.decisionNote,
        approval.editedPayload ? JSON.stringify(approval.editedPayload) : null,
        approval.version,
      ],
    );
    if (!row) throw new Error(`Failed to insert approval ${approval.id}`);
    return toApproval(row);
  }

  async updateApproval(id: string, expectedVersion: number, patch: ApprovalPatch): Promise<Approval> {
    const { sets, values } = buildPatch(
      {
        status: patch.status,
        decided_at: patch.decidedAt,
        decided_by: patch.decidedBy,
        decision_note: patch.decisionNote,
        edited_payload:
          patch.editedPayload !== undefined
            ? patch.editedPayload
              ? JSON.stringify(patch.editedPayload)
              : null
            : undefined,
      },
      [id, expectedVersion],
    );

    const row = await this.one<ApprovalRow>(
      `UPDATE approvals SET ${sets.join(", ")}, version = version + 1
       WHERE id = $1 AND version = $2 RETURNING *`,
      values,
    );
    if (row) return toApproval(row);

    return this.explainMissedUpdate("approval", id, expectedVersion);
  }

  async findExpiredApprovals(now: Date, limit: number): Promise<Approval[]> {
    const rows = await this.query<ApprovalRow>(
      `SELECT * FROM approvals
       WHERE status = 'pending' AND expires_at <= $1
       ORDER BY expires_at
       LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [now, limit],
    );
    return rows.map(toApproval);
  }

  /* ---------------------------------------------------------------- events -- */

  async listEvents(runId: string, afterSequence = 0): Promise<Event[]> {
    const rows = await this.query<EventRow>(
      "SELECT * FROM events WHERE run_id = $1 AND sequence > $2 ORDER BY sequence",
      [runId, afterSequence],
    );
    return rows.map(toEvent);
  }

  async appendEvent(event: Omit<Event, "id" | "sequence" | "at"> & { at?: Date }): Promise<Event> {
    // The sequence is computed inside the insert, so two concurrent appends cannot both
    // read the same maximum. The unique constraint on (run_id, sequence) is the backstop.
    const row = await this.one<EventRow>(
      `INSERT INTO events (id, run_id, task_id, type, sequence, actor, payload, at)
       SELECT $1, $2, $3, $4, COALESCE(MAX(sequence), 0) + 1, $5, $6, COALESCE($7::timestamptz, now())
       FROM events WHERE run_id = $2
       RETURNING *`,
      [
        `evt_${cryptoRandom()}`,
        event.runId,
        event.taskId,
        event.type,
        event.actor,
        JSON.stringify(event.payload),
        event.at ?? null,
      ],
    );
    if (!row) throw new Error(`Failed to append ${event.type} for run ${event.runId}`);
    return toEvent(row);
  }

  /* ---------------------------------------------------------------- outbox -- */

  async listOutbox(filter: { status?: OutboxMessage["status"]; limit?: number }): Promise<OutboxMessage[]> {
    const rows = filter.status
      ? await this.query<OutboxRow>(
          "SELECT * FROM outbox WHERE status = $1 ORDER BY created_at LIMIT $2",
          [filter.status, filter.limit ?? 100],
        )
      : await this.query<OutboxRow>("SELECT * FROM outbox ORDER BY created_at LIMIT $1", [filter.limit ?? 100]);
    return rows.map(toOutbox);
  }

  async enqueueOutbox(
    message: Omit<OutboxMessage, "id" | "createdAt" | "deliveredAt" | "lastError">,
  ): Promise<OutboxMessage> {
    const row = await this.one<OutboxRow>(
      `INSERT INTO outbox (id, run_id, task_id, channel, payload, idempotency_key, status,
                           attempts, max_attempts, next_attempt_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       -- One effect per key, ever. A retried task cannot produce a second email.
       ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
       RETURNING *`,
      [
        `obx_${cryptoRandom()}`,
        message.runId,
        message.taskId,
        message.channel,
        JSON.stringify(message.payload),
        message.idempotencyKey,
        message.status,
        message.attempts,
        message.maxAttempts,
        message.nextAttemptAt,
      ],
    );
    if (!row) throw new Error(`Failed to enqueue ${message.channel}`);
    return toOutbox(row);
  }

  async claimOutbox(now: Date, limit: number): Promise<OutboxMessage[]> {
    const rows = await this.query<OutboxRow>(
      `SELECT * FROM outbox
       WHERE status = 'pending' AND next_attempt_at <= $1
       ORDER BY created_at
       LIMIT $2
       FOR UPDATE SKIP LOCKED`,
      [now, limit],
    );
    return rows.map(toOutbox);
  }

  async markOutbox(id: string, patch: OutboxPatch): Promise<OutboxMessage> {
    const { sets, values } = buildPatch(
      {
        status: patch.status,
        attempts: patch.attempts,
        next_attempt_at: patch.nextAttemptAt,
        delivered_at: patch.deliveredAt,
        last_error: patch.lastError,
      },
      [id],
    );

    const row = await this.one<OutboxRow>(`UPDATE outbox SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, values);
    if (!row) throw new NotFoundError("outbox", id);
    return toOutbox(row);
  }

  /* ----------------------------------------------------------------- stats -- */

  async stats(): Promise<HarnessStats> {
    // One round trip. Six queries here would be six round trips on every console poll.
    const rows = await this.query<{ bucket: string; key: string; count: string }>(
      `SELECT 'run' AS bucket, status AS key, COUNT(*)::text AS count FROM runs GROUP BY status
       UNION ALL
       SELECT 'task', status, COUNT(*)::text FROM tasks GROUP BY status
       UNION ALL
       SELECT 'approval', status, COUNT(*)::text FROM approvals GROUP BY status
       UNION ALL
       SELECT 'outbox', status, COUNT(*)::text FROM outbox GROUP BY status`,
    );

    const runsByStatus: Record<string, number> = {};
    const tasksByStatus: Record<string, number> = {};
    let pendingApprovals = 0;
    let outboxPending = 0;
    let outboxFailed = 0;

    for (const row of rows) {
      const count = Number(row.count);
      if (row.bucket === "run") runsByStatus[row.key] = count;
      if (row.bucket === "task") tasksByStatus[row.key] = count;
      if (row.bucket === "approval" && row.key === "pending") pendingApprovals = count;
      if (row.bucket === "outbox" && row.key === "pending") outboxPending = count;
      if (row.bucket === "outbox" && (row.key === "failed" || row.key === "abandoned")) outboxFailed += count;
    }

    return {
      runsByStatus,
      tasksByStatus,
      pendingApprovals,
      outboxPending,
      outboxFailed,
      quarantinedTasks: tasksByStatus.quarantined ?? 0,
    };
  }

  /**
   * An update that returned no row is either a version conflict or a missing entity, and
   * telling them apart matters: one is retryable and one is a bug.
   */
  private async explainMissedUpdate(entity: string, id: string, expected: number): Promise<never> {
    const current = await this.one<{ version: number }>(
      `SELECT version FROM ${entity === "run" ? "runs" : entity === "task" ? "tasks" : "approvals"} WHERE id = $1`,
      [id],
    );
    if (!current) throw new NotFoundError(entity, id);
    throw new VersionConflictError(entity, id, expected, current.version);
  }
}

/* ---------------------------------------------------------------- mapping ---- */

function buildPatch(
  fields: Record<string, unknown>,
  leading: unknown[],
): { sets: string[]; values: unknown[] } {
  const values = [...leading];
  const sets: string[] = [];

  for (const [column, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  }

  // An update with nothing to set still has to bump the version, so give it something.
  if (sets.length === 0) sets.push("updated_at = now()");
  return { sets, values };
}

function cryptoRandom(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

interface RunRow {
  id: string;
  workflow: string;
  workflow_version: number;
  status: string;
  subject_type: string;
  subject_id: string;
  input: Record<string, unknown>;
  context: Record<string, unknown>;
  idempotency_key: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  error: Run["error"];
  labels: Record<string, string>;
}

function toRun(row: RunRow): Run {
  return {
    id: row.id,
    workflow: row.workflow,
    workflowVersion: row.workflow_version,
    status: row.status as Run["status"],
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    input: row.input,
    context: row.context,
    idempotencyKey: row.idempotency_key,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
    labels: row.labels,
  };
}

interface TaskRow {
  id: string;
  run_id: string;
  key: string;
  handler: string;
  status: string;
  depends_on: string[];
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  attempt: number;
  max_attempts: number;
  leased_by: string | null;
  lease_expires_at: Date | null;
  run_after: Date | null;
  approval_id: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  finished_at: Date | null;
  error: Task["error"];
}

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    runId: row.run_id,
    key: row.key,
    handler: row.handler,
    status: row.status as Task["status"],
    dependsOn: row.depends_on,
    input: row.input,
    output: row.output,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    leasedBy: row.leased_by,
    leaseExpiresAt: row.lease_expires_at,
    runAfter: row.run_after,
    approvalId: row.approval_id,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
    error: row.error,
  };
}

interface AttemptRow {
  id: string;
  task_id: string;
  run_id: string;
  attempt: number;
  worker_id: string;
  started_at: Date;
  finished_at: Date | null;
  outcome: string | null;
  error: TaskAttempt["error"];
  duration_ms: number | null;
}

function toAttempt(row: AttemptRow): TaskAttempt {
  return {
    id: row.id,
    taskId: row.task_id,
    runId: row.run_id,
    attempt: row.attempt,
    workerId: row.worker_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    outcome: row.outcome as TaskAttempt["outcome"],
    error: row.error,
    durationMs: row.duration_ms,
  };
}

interface ApprovalRow {
  id: string;
  run_id: string;
  task_id: string;
  summary: string;
  payload: Record<string, unknown>;
  required_roles: string[];
  status: string;
  requested_at: Date;
  expires_at: Date;
  decided_at: Date | null;
  decided_by: string | null;
  decision_note: string | null;
  edited_payload: Record<string, unknown> | null;
  version: number;
}

function toApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    summary: row.summary,
    payload: row.payload,
    requiredRoles: row.required_roles,
    status: row.status as Approval["status"],
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    decisionNote: row.decision_note,
    editedPayload: row.edited_payload,
    version: row.version,
  };
}

interface EventRow {
  id: string;
  run_id: string;
  task_id: string | null;
  type: string;
  sequence: number;
  actor: string;
  payload: Record<string, unknown>;
  at: Date;
}

function toEvent(row: EventRow): Event {
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    type: row.type as Event["type"],
    sequence: row.sequence,
    actor: row.actor,
    payload: row.payload,
    at: row.at,
  };
}

interface OutboxRow {
  id: string;
  run_id: string;
  task_id: string | null;
  channel: string;
  payload: Record<string, unknown>;
  idempotency_key: string;
  status: string;
  attempts: number;
  max_attempts: number;
  next_attempt_at: Date;
  created_at: Date;
  delivered_at: Date | null;
  last_error: string | null;
}

function toOutbox(row: OutboxRow): OutboxMessage {
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    channel: row.channel,
    payload: row.payload,
    idempotencyKey: row.idempotency_key,
    status: row.status as OutboxMessage["status"],
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    lastError: row.last_error,
  };
}
