"use client";

import type { RunView } from "@/lib/project";

/**
 * A run, collapsed to one line until you want more.
 *
 * The task strip is the density trick: one segment per task, coloured by status, so a
 * whole run's shape is readable without expanding anything. A dozen runs of eight tasks
 * each is a hundred facts in about as many pixels, and the eye finds the red one.
 */
export function RunRow({
  run,
  open,
  busy,
  onToggle,
  onRequeue,
  onCancel,
}: {
  run: RunView;
  open: boolean;
  busy: boolean;
  onToggle: () => void;
  onRequeue: (taskId: string) => void;
  onCancel: () => void;
}) {
  const stuck = run.tasks.find((task) => task.status === "quarantined" || task.status === "failed");
  const finished = ["succeeded", "failed", "cancelled"].includes(run.status);

  return (
    <article className="run">
      <button type="button" className="run__head" onClick={onToggle} aria-expanded={open}>
        <span className="run__title">
          <span className="run__customer">{run.customer}</span>
          <span className="run__workflow mono">{run.workflow}</span>
          <span className="run__workflow mono">{run.id}</span>
        </span>
        <span className="run__status" data-status={run.status}>
          {run.status.replace(/_/g, " ")}
        </span>
        <span className="run__headline">{run.headline}</span>
        <span className="track" aria-hidden="true">
          {run.tasks.map((task) => (
            <span key={task.id} className="track__seg" data-status={task.status} title={`${task.key}: ${task.status}`} />
          ))}
        </span>
      </button>

      {open ? (
        <div className="run__detail">
          <div>
            <div className="subhead">
              Tasks — {run.taskCount} steps, {Math.round(run.progress * 100)}% settled
            </div>
            <div className="tasks">
              {run.tasks.map((task) => (
                <div className="task" key={task.id} data-status={task.status}>
                  <span className="task__dot" />
                  <span>
                    <span className="mono">{task.key}</span>
                    {task.isApprovalGate ? <span className="task__gate">gate</span> : null}
                  </span>
                  <span className="task__meta">
                    {task.status}
                    {task.attempt > 1 ? ` · ${task.attempt}/${task.maxAttempts}` : ""}
                    {task.durationMs !== null ? ` · ${task.durationMs}ms` : ""}
                  </span>
                  {task.error ? <span className="task__error">{task.error}</span> : null}
                  {task.attempts.length > 1 ? (
                    <span className="task__attempts">
                      {task.attempts
                        .map((attempt) => `#${attempt.attempt} ${attempt.outcome ?? "in flight"}`)
                        .join(" · ")}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>

            <div className="run__actions">
              {stuck ? (
                <button type="button" className="btn btn--small" disabled={busy} onClick={() => onRequeue(stuck.id)}>
                  Requeue {stuck.key}
                </button>
              ) : null}
              {finished ? null : (
                <button type="button" className="btn btn--quiet btn--small" disabled={busy} onClick={onCancel}>
                  Cancel this run
                </button>
              )}
            </div>
          </div>

          <div>
            <div className="subhead">Audit trail — every state change, append-only, with who caused it</div>
            <div className="events">
              {run.events.map((event) => (
                <div className="event" key={event.sequence}>
                  <span className="event__seq">{event.sequence}</span>
                  <span>
                    <span className="event__type mono">{event.type}</span>{" "}
                    <span className="event__detail">{event.detail}</span>{" "}
                    <span className="event__actor">— {event.actor}</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </article>
  );
}
