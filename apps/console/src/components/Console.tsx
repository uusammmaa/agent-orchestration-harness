"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { StoreSnapshot } from "@harness/core";
import type { ConsoleState } from "@/lib/project";
import { ApprovalCard } from "./ApprovalCard";
import { RunRow } from "./RunRow";

/**
 * The console.
 *
 * The browser owns the store snapshot and posts it with every action. That is what lets
 * the hosted demo run the real engine — the same Engine, Worker and handlers a production
 * deployment uses — with no database behind it, and it means two people looking at the
 * demo never see each other's decisions.
 */

interface HarnessResponse {
  snapshot: StoreSnapshot;
  state: ConsoleState;
  delivered: Array<{ channel: string; idempotencyKey: string; payload: Record<string, unknown>; at: string }>;
  message: string;
}

type Command =
  | { action: "seed" }
  | { action: "refresh" }
  | {
      action: "decide";
      approvalId: string;
      decision: "approved" | "rejected";
      note?: string;
      editedPayload?: Record<string, unknown>;
      roles?: string[];
    }
  | { action: "requeue"; taskId: string }
  | { action: "cancel"; runId: string; reason: string }
  | { action: "expire" }
  | { action: "start"; workflow: string; subjectId: string; input: Record<string, unknown>; labels?: Record<string, string> };

export function Console() {
  const [state, setState] = useState<ConsoleState | null>(null);
  /*
   * The snapshot lives in a ref, not in state.
   *
   * Nothing renders from it — it is the payload for the next request — and keeping it in
   * state would change `send`'s identity on every action, which in turn would make the
   * mount effect's dependency list a lie.
   */
  const snapshot = useRef<StoreSnapshot | null>(null);
  const [delivered, setDelivered] = useState<HarnessResponse["delivered"]>([]);
  const [message, setMessage] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const send = useCallback(
    async (command: Command) => {
      setBusy(true);
      setError(null);
      try {
        const response = await fetch("/api/harness", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(command.action === "seed" ? command : { ...command, snapshot: snapshot.current }),
        });

        const payload = (await response.json()) as HarnessResponse & { title?: string; detail?: string };
        if (!response.ok) throw new Error(payload.detail ?? payload.title ?? `Request failed (${response.status})`);

        snapshot.current = payload.snapshot;
        setState(payload.state);
        setMessage(payload.message);
        // Effects accumulate across actions, so the log reads like a session.
        if (payload.delivered.length > 0) {
          setDelivered((previous) => [...payload.delivered, ...previous].slice(0, 40));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not reach the harness.");
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  useEffect(() => {
    void send({ action: "seed" });
  }, [send]);

  const pending = state?.approvals.filter((approval) => approval.status === "pending") ?? [];
  const decided = state?.approvals.filter((approval) => approval.status !== "pending") ?? [];

  return (
    <>
      <header className="top">
        <div className="top__inner">
          <span className="wordmark">
            Harness <span>ops</span>
          </span>
          <span className="top__what">Agent orchestration · accounts receivable and sales</span>
          <div className="chips">
            <span className="chip">store: in-memory</span>
            <span className="chip">odoo: stub</span>
            <span className="chip">agents: rules</span>
          </div>
        </div>
      </header>

      <div className="strip">
        <div className="strip__inner">
          <span className="stat" data-tone={pending.length > 0 ? "amber" : undefined}>
            <b>{state?.stats.pendingApprovals ?? 0}</b> waiting on you
          </span>
          <span className="stat">
            <b>{state?.stats.running ?? 0}</b> running
          </span>
          <span className="stat" data-tone={(state?.stats.failed ?? 0) > 0 ? "red" : undefined}>
            <b>{state?.stats.failed ?? 0}</b> stopped
          </span>
          <span className="stat" data-tone="green">
            <b>{state?.stats.succeeded ?? 0}</b> finished
          </span>
          <span className="stat" data-tone={(state?.stats.outboxAbandoned ?? 0) > 0 ? "red" : undefined}>
            <b>{state?.stats.outboxAbandoned ?? 0}</b> effects abandoned
          </span>

          <div className="strip__actions">
            <button type="button" className="btn btn--quiet btn--small" disabled={busy} onClick={() => void send({ action: "expire" })}>
              Expire overdue approvals
            </button>
            <button type="button" className="btn btn--quiet btn--small" disabled={busy} onClick={() => void send({ action: "refresh" })}>
              Tick the worker
            </button>
            <button type="button" className="btn btn--small" disabled={busy} onClick={() => void send({ action: "seed" })}>
              Reset
            </button>
          </div>
        </div>
      </div>

      <main className="shell">
        <div className="intro">
          <h1>What needs a person, and what the machine is doing</h1>
          <p>
            This is the real engine running in your browser session — the same durable execution, approval gates and
            transactional outbox a production deployment uses, with an in-memory store and a stub Odoo behind it.
          </p>
          <p>
            Approve something and watch the run resume. Reject it and watch nothing get sent. Both decisions are on the
            record afterwards, with your name against them.
          </p>
        </div>

        {error ? (
          <div className="notice" data-tone="error">
            {error}
          </div>
        ) : message ? (
          <div className="notice">{message}</div>
        ) : null}

        <div className="columns">
          <section aria-label="Approvals">
            <div className="col__head">
              <h2 className="col__title">Needs you</h2>
              <span className="col__count">
                {pending.length} pending{decided.length > 0 ? `, ${decided.length} decided` : ""}
              </span>
            </div>

            {pending.length === 0 ? (
              <p className="empty">
                Nothing is waiting on a decision. Approve or reject everything here and the queue empties — then use
                Reset to start over.
              </p>
            ) : (
              pending.map((approval) => (
                <ApprovalCard
                  key={approval.id}
                  approval={approval}
                  busy={busy}
                  onDecide={(decision, note, editedPayload) =>
                    void send({
                      action: "decide",
                      approvalId: approval.id,
                      decision,
                      ...(note ? { note } : {}),
                      ...(editedPayload ? { editedPayload } : {}),
                    })
                  }
                />
              ))
            )}

            {decided.length > 0 ? (
              <>
                <div className="col__head col__head--spaced">
                  <h2 className="col__title">Decided</h2>
                </div>
                {decided.map((approval) => (
                  <div className="approval approval--decided" key={approval.id}>
                    <div className="approval__head">
                      <p className="approval__summary">{approval.summary}</p>
                      <div className="approval__meta">
                        <span>{approval.status}</span>
                        {approval.decidedBy ? <span>by {approval.decidedBy}</span> : null}
                        {approval.wasEdited ? <span>edited before approval</span> : null}
                      </div>
                      {approval.decisionNote ? (
                        <p className="approval__reason">“{approval.decisionNote}”</p>
                      ) : null}
                    </div>
                  </div>
                ))}
              </>
            ) : null}
          </section>

          <section aria-label="Runs">
            <div className="col__head">
              <h2 className="col__title">Runs</h2>
              <span className="col__count">{state?.runs.length ?? 0} in the last sweep</span>
            </div>

            {(state?.runs ?? []).map((run) => (
              <RunRow
                key={run.id}
                run={run}
                open={expanded === run.id}
                busy={busy}
                onToggle={() => setExpanded(expanded === run.id ? null : run.id)}
                onRequeue={(taskId) => void send({ action: "requeue", taskId })}
                onCancel={() => void send({ action: "cancel", runId: run.id, reason: "Cancelled from the console" })}
              />
            ))}

            <section className="effects" aria-label="Effects delivered">
              <div className="subhead">
                Effects delivered from the outbox — each one exactly once, keyed so a retried task cannot send twice
              </div>
              {delivered.length === 0 && (state?.outbox.length ?? 0) === 0 ? (
                <p className="effects__empty">Nothing has left the system yet.</p>
              ) : (
                <>
                  {delivered.map((effect) => (
                    <div className="effect" key={effect.idempotencyKey}>
                      <span className="effect__channel">{effect.channel}</span>
                      <span>{summarise(effect.channel, effect.payload)}</span>
                      <span className="effect__key mono">{effect.idempotencyKey}</span>
                    </div>
                  ))}
                  {(state?.outbox ?? [])
                    .filter((message) => message.status !== "delivered")
                    .map((message) => (
                      <div className="effect" key={message.id} data-status={message.status}>
                        <span className="effect__channel">{message.channel}</span>
                        <span>
                          {message.summary}
                          {message.lastError ? ` — ${message.lastError}` : ""}
                        </span>
                        <span className="effect__key mono">
                          {message.status} · {message.attempts}/{message.maxAttempts}
                        </span>
                      </div>
                    ))}
                </>
              )}
            </section>
          </section>
        </div>

        <footer className="foot">
          <p>What this demo is honest about:</p>
          <ul>
            <li>No email is sent and no ERP is written to — the Odoo client talks to a stub over real XML-RPC.</li>
            <li>The store is in memory and lives in your browser session. Reset clears it.</li>
            <li>
              The agents are the rules brain, not Claude. Both implement the same contract; set{" "}
              <code>ANTHROPIC_API_KEY</code> and the model takes over.
            </li>
            <li>
              Everything else — the engine, leasing, retries, approval gates, the outbox, the audit trail — is the code
              that would run in production.
            </li>
          </ul>
        </footer>
      </main>
    </>
  );
}

function summarise(channel: string, payload: Record<string, unknown>): string {
  if (channel === "email.send") return `to ${String(payload.to ?? "")} — ${String(payload.subject ?? "")}`;
  if (channel === "ticket.create") return `${String(payload.queue ?? "")}: ${String(payload.subject ?? "")}`;
  if (channel === "run.schedule") return `follow-up scheduled for ${String(payload.runAt ?? "").slice(0, 10)}`;
  return JSON.stringify(payload).slice(0, 100);
}
