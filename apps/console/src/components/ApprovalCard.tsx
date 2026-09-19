"use client";

import { useState } from "react";
import type { ApprovalView } from "@/lib/project";

/**
 * One decision, with the actual text in front of it.
 *
 * Showing the draft is the whole point of an approval gate. A card that said "approve
 * reminder for invoice 5001?" would be a rubber stamp; showing what the customer will
 * read is what makes the approval mean something.
 *
 * Editing is first-class for the same reason. Most approvals in practice are "yes, but
 * soften that line", and a system with only yes and no pushes people into approving
 * something they would rather have changed.
 */
export function ApprovalCard({
  approval,
  busy,
  onDecide,
}: {
  approval: ApprovalView;
  busy: boolean;
  onDecide: (decision: "approved" | "rejected", note?: string, editedPayload?: Record<string, unknown>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(String(approval.payload.body ?? ""));
  const [note, setNote] = useState("");
  const [leaving, setLeaving] = useState(false);

  const overdue = approval.hoursRemaining < 0;
  const edited = editing && body !== String(approval.payload.body ?? "");

  function decide(decision: "approved" | "rejected") {
    setLeaving(true);
    onDecide(decision, note.trim() || undefined, edited ? { ...approval.payload, body } : undefined);
  }

  return (
    <article className="approval" data-leaving={leaving}>
      <div className="approval__head">
        <p className="approval__summary">{approval.summary}</p>
        <div className="approval__meta">
          <span className="mono">{approval.workflow}</span>
          <span>{approval.customer}</span>
          <span>needs {approval.requiredRoles.join(" or ")}</span>
          <span className="approval__due" data-overdue={overdue}>
            {overdue
              ? `${Math.abs(Math.round(approval.hoursRemaining))}h past the deadline`
              : `${Math.round(approval.hoursRemaining)}h left`}
          </span>
        </div>
      </div>

      <div className="draft">
        <p className="draft__subject">{approval.subject}</p>
        {editing ? (
          <>
            <label className="sr-only" htmlFor={`body-${approval.id}`}>
              The message that will be sent
            </label>
            <textarea id={`body-${approval.id}`} value={body} onChange={(event) => setBody(event.target.value)} />
          </>
        ) : (
          <p className="draft__body">{String(approval.payload.body ?? "(nothing to show)")}</p>
        )}
      </div>

      <div className="approval__note">
        <label className="sr-only" htmlFor={`note-${approval.id}`}>
          Why, for the record
        </label>
        <input
          id={`note-${approval.id}`}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Why — this is kept on the record"
          disabled={busy}
        />
      </div>

      <div className="approval__actions">
        <button type="button" className="btn" disabled={busy} onClick={() => decide("approved")}>
          {edited ? "Approve my edit" : "Approve"}
        </button>
        <button type="button" className="btn btn--danger" disabled={busy} onClick={() => decide("rejected")}>
          Reject
        </button>
        <button type="button" className="btn btn--quiet btn--small" disabled={busy} onClick={() => setEditing(!editing)}>
          {editing ? "Stop editing" : "Edit the message"}
        </button>
        {edited ? (
          <span className="approval__edited">
            Your version is what gets approved — the original stays on the record.
          </span>
        ) : null}
      </div>
    </article>
  );
}
