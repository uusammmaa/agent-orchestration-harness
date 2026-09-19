import type { Task } from "../domain/types";
import type { Engine } from "./engine";

/**
 * The worker loop.
 *
 * Lease a batch, run each task, report the result. Everything interesting is in what it
 * does when that goes wrong:
 *
 *  - **Heartbeats.** A task that legitimately takes four minutes must not have its lease
 *    expire underneath it, so the lease is short and extended while work is in progress.
 *    Short leases are what make crash recovery fast; heartbeats are what make short
 *    leases safe.
 *  - **Graceful shutdown.** On SIGTERM it stops leasing and finishes what it holds. A
 *    worker that drops its tasks mid-flight turns every deploy into a recovery event.
 *  - **Nothing thrown escapes.** A handler that throws is a failed task, not a dead
 *    worker.
 */

export interface HandlerContext {
  task: Task;
  workerId: string;
  /** Call for long work; extends the lease so the reaper does not reclaim it. */
  heartbeat: () => Promise<void>;
  signal: AbortSignal;
}

export interface HandlerResult {
  output: Record<string, unknown>;
  /** Effects to deliver once the state change commits. */
  outbox?: Array<{ channel: string; payload: Record<string, unknown>; idempotencyKey: string }>;
  /** Suspends the task pending a human decision instead of completing it. */
  approval?: {
    summary: string;
    payload: Record<string, unknown>;
    requiredRoles: string[];
    expiresInHours: number;
  };
}

export type Handler = (context: HandlerContext) => Promise<HandlerResult>;

/**
 * A failure a handler can raise to say whether it is worth trying again.
 *
 * Anything else that escapes a handler is treated as permanent, because retrying an
 * unrecognised failure three times usually produces the same unrecognised failure three
 * times.
 */
export class HandlerError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "HandlerError";
  }
}

export interface WorkerOptions {
  engine: Engine;
  handlers: Record<string, Handler>;
  workerId?: string;
  /** How many tasks to hold at once. */
  concurrency?: number;
  /** Lease duration. Short, because heartbeats extend it. */
  leaseMs?: number;
  /** How often to extend a lease while a handler is running. */
  heartbeatMs?: number;
  /** Idle sleep between polls when there was nothing to do. */
  pollMs?: number;
  /** Restrict this worker to certain handlers. */
  handlerFilter?: string[];
  /** Run the lease reaper and approval-expiry sweeper from this worker. */
  runMaintenance?: boolean;
  logger?: { info: (msg: string, meta?: unknown) => void; error: (msg: string, meta?: unknown) => void };
}

const noopLogger = { info: () => undefined, error: () => undefined };

export class Worker {
  readonly id: string;
  private running = false;
  private stopping = false;
  private inFlight = new Set<Promise<void>>();
  private readonly controller = new AbortController();

  constructor(private readonly options: WorkerOptions) {
    this.id = options.workerId ?? `worker-${process.pid ?? 0}-${Math.random().toString(36).slice(2, 8)}`;
  }

  get busy(): number {
    return this.inFlight.size;
  }

  /** One pass: lease what is available and run it. Returns how many tasks it picked up. */
  async tick(): Promise<number> {
    const concurrency = this.options.concurrency ?? 4;
    const capacity = concurrency - this.inFlight.size;
    if (capacity <= 0 || this.stopping) return 0;

    if (this.options.runMaintenance) {
      // Reclaim before leasing, so a task freed this tick is available this tick.
      await this.options.engine.reclaimExpiredLeases().catch((error) => this.log.error("reclaim failed", error));
      await this.options.engine.expireApprovals().catch((error) => this.log.error("expiry sweep failed", error));
    }

    const leased = await this.options.engine.leaseTasks(
      this.id,
      capacity,
      this.options.leaseMs ?? 30_000,
      this.options.handlerFilter,
    );

    for (const task of leased) {
      const work = this.run(task).finally(() => this.inFlight.delete(work));
      this.inFlight.add(work);
    }
    return leased.length;
  }

  /** Poll until `stop()` is called. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.log.info(`worker ${this.id} started`);

    while (!this.stopping) {
      let leased = 0;
      try {
        leased = await this.tick();
      } catch (error) {
        // A failure to lease is usually the database being briefly unavailable. Log and
        // carry on; dying here would need an orchestrator to notice and restart us.
        this.log.error("tick failed", error);
      }
      // Sleep only when idle, so a busy queue drains at full speed.
      if (leased === 0) await sleep(this.options.pollMs ?? 500);
    }

    await this.drain();
    this.running = false;
    this.log.info(`worker ${this.id} stopped`);
  }

  /** Stop leasing, then wait for in-flight work. */
  async stop(): Promise<void> {
    this.stopping = true;
    await this.drain();
  }

  /** For a hard shutdown: aborts handler signals as well. */
  async abort(): Promise<void> {
    this.stopping = true;
    this.controller.abort();
    await this.drain();
  }

  /**
   * Wait for everything in flight, without stopping the worker.
   *
   * `stop()` is one-way by design — a worker told to stop must not quietly resume — so a
   * caller that wants "process this batch and wait" needs its own way to do it. Tests and
   * one-shot CLI runs both do.
   */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  private async run(task: Task): Promise<void> {
    const handler = this.options.handlers[task.handler];

    if (!handler) {
      // An unregistered handler is a deployment mistake, not a transient failure.
      await this.reportFailure(task, {
        code: "worker.no_handler",
        message: `No handler registered for "${task.handler}"`,
        retryable: false,
      });
      return;
    }

    const heartbeat = this.startHeartbeat(task);

    try {
      const result = await handler({
        task,
        workerId: this.id,
        heartbeat: () => this.extendLease(task),
        signal: this.controller.signal,
      });

      if (result.approval) {
        await this.options.engine.requestApproval({
          taskId: task.id,
          workerId: this.id,
          ...result.approval,
        });
        return;
      }

      await this.options.engine.completeTask({
        taskId: task.id,
        workerId: this.id,
        output: result.output,
        ...(result.outbox ? { outbox: result.outbox } : {}),
      });
    } catch (error) {
      const failure =
        error instanceof HandlerError
          ? { code: error.code, message: error.message, retryable: error.retryable }
          : {
              code: "handler.unknown",
              message: error instanceof Error ? error.message : String(error),
              retryable: false,
            };
      await this.reportFailure(task, failure);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async reportFailure(
    task: Task,
    error: { code: string; message: string; retryable: boolean },
  ): Promise<void> {
    try {
      await this.options.engine.failTask({ taskId: task.id, workerId: this.id, error });
    } catch (reportError) {
      /*
       * We could not even record the failure. Leave it: the lease will expire and the
       * reaper will return the task to the queue. Retrying the report here risks a loop
       * against the same unavailable database.
       */
      this.log.error(`could not record failure of ${task.id}`, reportError);
    }
  }

  private startHeartbeat(task: Task): ReturnType<typeof setInterval> {
    const interval = this.options.heartbeatMs ?? Math.floor((this.options.leaseMs ?? 30_000) / 3);
    const timer = setInterval(() => {
      void this.extendLease(task).catch(() => undefined);
    }, interval);
    // A heartbeat must not keep the process alive on its own.
    timer.unref?.();
    return timer;
  }

  private async extendLease(task: Task): Promise<void> {
    await this.options.engine.store.transaction(async (tx) => {
      const current = await tx.getTask(task.id);
      // Only extend a lease we still hold. If it was reclaimed, the extension would
      // steal it back from whoever picked it up.
      if (!current || current.status !== "leased" || current.leasedBy !== this.id) return;

      await tx.updateTask(current.id, current.version, {
        leaseExpiresAt: new Date(Date.now() + (this.options.leaseMs ?? 30_000)),
      });
    });
  }

  private get log() {
    return this.options.logger ?? noopLogger;
  }
}

/**
 * Deliver outbox messages.
 *
 * Separate from the task worker on purpose: delivery failures must not fail the task
 * that produced the message, and the two have different retry profiles. A task retries
 * three times over minutes; an email delivery retries five times over hours.
 */
export interface DispatcherOptions {
  engine: Engine;
  channels: Record<string, (payload: Record<string, unknown>, idempotencyKey: string) => Promise<void>>;
  batchSize?: number;
  backoff?: (attempt: number) => number;
  logger?: WorkerOptions["logger"];
}

export class OutboxDispatcher {
  constructor(private readonly options: DispatcherOptions) {}

  async tick(now = new Date()): Promise<number> {
    const claimed = await this.options.engine.store.transaction((tx) =>
      tx.claimOutbox(now, this.options.batchSize ?? 20),
    );

    for (const message of claimed) {
      const deliver = this.options.channels[message.channel];

      if (!deliver) {
        await this.fail(message.id, message.attempts + 1, message.maxAttempts, `No channel "${message.channel}"`, now);
        continue;
      }

      try {
        // The idempotency key goes to the receiving side, which is where duplicate
        // suppression has to happen: we cannot know whether a timed-out send arrived.
        await deliver(message.payload, message.idempotencyKey);
        await this.options.engine.store.transaction((tx) =>
          tx.markOutbox(message.id, { status: "delivered", deliveredAt: now, attempts: message.attempts + 1 }),
        );
      } catch (error) {
        await this.fail(
          message.id,
          message.attempts + 1,
          message.maxAttempts,
          error instanceof Error ? error.message : String(error),
          now,
        );
      }
    }
    return claimed.length;
  }

  private async fail(id: string, attempts: number, maxAttempts: number, reason: string, now: Date): Promise<void> {
    const backoff = this.options.backoff ?? ((attempt: number) => Math.min(3_600_000, 5_000 * 2 ** attempt));
    // Abandoned, not failed: it is out of attempts and needs a person, and the
    // distinction is what lets an operator filter the queue to things they can fix.
    const exhausted = attempts >= maxAttempts;

    await this.options.engine.store.transaction((tx) =>
      tx.markOutbox(id, {
        status: exhausted ? "abandoned" : "pending",
        attempts,
        nextAttemptAt: new Date(now.getTime() + backoff(attempts)),
        lastError: reason,
      }),
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
