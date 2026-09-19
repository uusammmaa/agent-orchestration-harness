import { z } from "zod";
import { HandlerError, type Handler, type HandlerResult } from "@harness/core";
import { OdooError, type OdooClient } from "@harness/odoo";
import type { Brain } from "./brain";

/**
 * The handlers.
 *
 * One per `handler` string in the workflow definitions. Three kinds:
 *
 *  - `odoo.*`  — read from or write to the ERP
 *  - `agent.*` — ask a brain for a structured judgement
 *  - `effect.*`, `system.*` — everything else
 *
 * Every handler must be idempotent, because a task can be run twice: a worker can die
 * after doing the work and before reporting it, and the lease reaper will hand the task
 * to somebody else. That is not a rare case to defend against; it is the normal
 * consequence of a deploy.
 *
 * Writes that leave the system do not happen here at all. They go on the outbox, which
 * commits in the same transaction as the task result and is delivered once.
 */

export interface HandlerDeps {
  odoo: OdooClient;
  brain: Brain;
  now?: () => Date;
}

/* ------------------------------------------------------------------ schemas ---- */

const assessment = z.object({
  tone: z.enum(["gentle", "firm", "formal", "final_notice"]),
  risk: z.enum(["low", "medium", "high"]),
  escalate: z.boolean(),
  suggestPaymentPlan: z.boolean(),
});

const draft = z.object({
  subject: z.string().min(3),
  body: z.string().min(20),
  tone: z.string(),
});

const qualification = z.object({
  recommendation: z.enum(["follow_up", "nurture", "close_lost"]),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  suggestedAngle: z.enum(["value", "timing", "check_in"]),
});

const outreach = z.object({
  subject: z.string().min(3),
  body: z.string().min(20),
  angle: z.string(),
});

/** Turn an Odoo failure into the retryability signal the engine needs. */
function rethrowOdoo(error: unknown): never {
  if (error instanceof OdooError) throw new HandlerError(error.message, error.code, error.retryable);
  throw new HandlerError(
    error instanceof Error ? error.message : String(error),
    "handler.unknown",
    false,
  );
}

function requireNumber(input: Record<string, unknown>, key: string): number {
  const value = input[key];
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    // A missing id is a workflow-definition bug; retrying will not conjure one.
    throw new HandlerError(`Task input is missing a numeric "${key}"`, "handler.bad_input", false);
  }
  return parsed;
}

export function buildHandlers(deps: HandlerDeps): Record<string, Handler> {
  const now = deps.now ?? (() => new Date());

  return {
    /* ------------------------------------------------------------- odoo reads -- */

    "odoo.fetch_invoice": async ({ task }) => {
      const invoiceId = requireNumber(task.input, "invoiceId");
      try {
        const invoice = await deps.odoo.fetchInvoice(invoiceId, now());
        const partner = invoice.partnerId ? await deps.odoo.fetchPartner(invoice.partnerId) : null;
        return {
          output: {
            ...invoice,
            lifetimeValue: partner?.lifetimeValue ?? 0,
            trust: partner?.trust ?? "normal",
          },
        };
      } catch (error) {
        rethrowOdoo(error);
      }
    },

    "odoo.fetch_lead": async ({ task }) => {
      const leadId = requireNumber(task.input, "leadId");
      try {
        return { output: { ...(await deps.odoo.fetchLead(leadId, now())) } };
      } catch (error) {
        rethrowOdoo(error);
      }
    },

    /* ------------------------------------------------------------ odoo writes -- */

    "odoo.log_activity": async ({ task }) => {
      const input = task.input as { model?: string; recordId?: number; invoiceId?: number; summary?: string; note?: string };
      const model = input.model ?? "account.move";
      const recordId = input.recordId ?? input.invoiceId;
      if (typeof recordId !== "number") {
        throw new HandlerError("Nothing to log the activity against", "handler.bad_input", false);
      }

      /*
       * Idempotency by inspection. Odoo has no idempotency key on `mail.message`, so the
       * only way to avoid a duplicate note after a retry is to look for one first. It is
       * a read plus a write rather than an atomic upsert, which is a genuine race — but
       * the consequence of losing it is a duplicated note, and the consequence of not
       * checking is a duplicated note every single retry.
       */
      try {
        const existing = await deps.odoo.searchRead<{ id: number; subject: unknown }>(
          "mail.message",
          [
            ["model", "=", model],
            ["res_id", "=", recordId],
            ["subject", "=", input.summary ?? ""],
          ],
          ["id", "subject"],
          { limit: 1 },
        );
        if (existing.length > 0) {
          return { output: { messageId: existing[0]?.id ?? 0, alreadyLogged: true } };
        }

        const messageId = await deps.odoo.logActivity({
          model,
          recordId,
          summary: input.summary ?? "Activity",
          note: input.note ?? "",
        });
        return { output: { messageId, alreadyLogged: false } };
      } catch (error) {
        rethrowOdoo(error);
      }
    },

    "odoo.update_lead": async ({ task }) => {
      const leadId = requireNumber(task.input, "leadId");
      const input = task.input as { stage?: string; note?: string };
      try {
        await deps.odoo.updateLead(leadId, { description: input.note ?? "" });
        if (input.note) {
          await deps.odoo.logActivity({
            model: "crm.lead",
            recordId: leadId,
            summary: "Moved to nurture",
            note: input.note,
          });
        }
        return { output: { leadId, stage: input.stage ?? null } };
      } catch (error) {
        rethrowOdoo(error);
      }
    },

    /* ---------------------------------------------------------------- agents -- */

    "agent.ar_assessor": async ({ task, heartbeat }) => {
      await heartbeat();
      const result = await deps.brain.think({
        agent: "ar_assessor",
        facts: task.input,
        rules: [
          "Never recommend legal action; that is a human decision.",
          "A customer with a long good payment history gets a softer first chase.",
          "Never suggest a discount or a write-off.",
        ],
        schema: {
          description: "How hard to chase this invoice",
          jsonSchema: {
            type: "object",
            properties: {
              tone: { type: "string", enum: ["gentle", "firm", "formal", "final_notice"] },
              risk: { type: "string", enum: ["low", "medium", "high"] },
              escalate: { type: "boolean" },
              suggestPaymentPlan: { type: "boolean" },
            },
            required: ["tone", "risk", "escalate", "suggestPaymentPlan"],
          },
          parse: (value) => assessment.parse(value),
        },
      });

      return { output: { ...result.output, reasoning: result.reasoning, confidence: result.confidence } };
    },

    "agent.ar_drafter": async ({ task, heartbeat }) => {
      await heartbeat();
      const result = await deps.brain.think({
        agent: "ar_drafter",
        facts: task.input,
        rules: [
          "Never threaten legal action or mention a credit agency.",
          "Never state a figure that is not the outstanding amount given to you.",
          "Always offer a way to raise a query.",
          "Be brief; nobody reads a long chasing email.",
        ],
        schema: {
          description: "The reminder email",
          jsonSchema: {
            type: "object",
            properties: { subject: { type: "string" }, body: { type: "string" }, tone: { type: "string" } },
            required: ["subject", "body", "tone"],
          },
          parse: (value) => draft.parse(value),
        },
      });

      return { output: { ...result.output, reasoning: result.reasoning, confidence: result.confidence } };
    },

    "agent.lead_qualifier": async ({ task, heartbeat }) => {
      await heartbeat();
      const result = await deps.brain.think({
        agent: "lead_qualifier",
        facts: task.input,
        rules: [
          "Recommend close_lost only after at least four approaches with no reply.",
          "Never contact a lead that has opted out or bounced.",
        ],
        schema: {
          description: "Whether this lead is worth chasing",
          jsonSchema: {
            type: "object",
            properties: {
              recommendation: { type: "string", enum: ["follow_up", "nurture", "close_lost"] },
              confidence: { type: "number" },
              reasoning: { type: "string" },
              suggestedAngle: { type: "string", enum: ["value", "timing", "check_in"] },
            },
            required: ["recommendation", "confidence", "reasoning", "suggestedAngle"],
          },
          parse: (value) => qualification.parse(value),
        },
      });

      return { output: { ...result.output, confidence: result.confidence } };
    },

    "agent.lead_writer": async ({ task, heartbeat }) => {
      await heartbeat();
      const result = await deps.brain.think({
        agent: "lead_writer",
        facts: task.input,
        rules: [
          "Never invent a previous conversation or a commitment they did not make.",
          "Never quote a price.",
          "Always give them an easy way to say no.",
        ],
        schema: {
          description: "The follow-up email",
          jsonSchema: {
            type: "object",
            properties: { subject: { type: "string" }, body: { type: "string" }, angle: { type: "string" } },
            required: ["subject", "body", "angle"],
          },
          parse: (value) => outreach.parse(value),
        },
      });

      return { output: { ...result.output, reasoning: result.reasoning, confidence: result.confidence } };
    },

    /* ---------------------------------------------------------------- system -- */

    /**
     * The approval gate.
     *
     * It does no work. Its only job is to suspend the run and put the draft in front of a
     * person. Whether it is reached at all is decided by the workflow's `when` guard, so
     * "does this need sign-off" stays a policy question in the workflow definition rather
     * than a condition buried in a handler.
     */
    "system.approval_gate": async ({ task }): Promise<HandlerResult> => {
      const input = task.input as {
        draft?: Record<string, unknown>;
        summary?: string;
        requiredRoles?: string[];
        expiresInHours?: number;
      };

      // Second time through: the approval came back, so pass the approved content on.
      if (task.approvalId !== null) {
        return { output: { ...(input.draft ?? {}), approved: true } };
      }

      return {
        output: {},
        approval: {
          // The workflow resolved these when it promoted the task; the handler only
          // carries them, so the policy stays in one readable place.
          summary: input.summary ?? "Approve before this is sent",
          payload: input.draft ?? {},
          requiredRoles: input.requiredRoles ?? ["ar_manager"],
          expiresInHours: input.expiresInHours ?? 48,
        },
      };
    },

    "system.raise_ticket": async ({ task }) => {
      const input = task.input as { queue?: string; subject?: string; partner?: string };
      return {
        output: { queue: input.queue ?? "general", subject: input.subject ?? "Needs a person", raisedAt: now().toISOString() },
        outbox: [
          {
            channel: "ticket.create",
            payload: { ...input },
            idempotencyKey: `ticket:${task.runId}:${task.key}`,
          },
        ],
      };
    },

    "system.schedule_run": async ({ task }) => {
      const input = task.input as { workflow?: string; subjectId?: string; runAfterDays?: number | null; input?: Record<string, unknown> };

      // The top of the dunning ladder is the end of the automated process. What happens
      // after a final notice is a decision for a person, not a cron job.
      if (input.runAfterDays === null || input.runAfterDays === undefined) {
        return { output: { scheduled: false, reason: "No further stage in the ladder" } };
      }

      const runAt = new Date(now().getTime() + input.runAfterDays * 86_400_000);
      return {
        output: { scheduled: true, runAt: runAt.toISOString() },
        outbox: [
          {
            channel: "run.schedule",
            payload: {
              workflow: input.workflow,
              subjectId: input.subjectId,
              input: input.input ?? {},
              runAt: runAt.toISOString(),
            },
            // One follow-up per run, whatever happens on retry.
            idempotencyKey: `schedule:${task.runId}`,
          },
        ],
      };
    },

    /* ---------------------------------------------------------------- effects -- */

    /**
     * Sending is not done here.
     *
     * The handler puts the message on the outbox and returns. The dispatcher delivers it
     * after the transaction commits, so a crash between "task succeeded" and "email sent"
     * is impossible: either both happened or neither did.
     */
    "effect.send_email": async ({ task }) => {
      const input = task.input as { to?: string; draft?: { subject?: string; body?: string }; invoiceNumber?: string; leadId?: number };
      const to = input.to;
      const draftContent = input.draft ?? {};

      if (!to) {
        throw new HandlerError("No recipient on the task input", "handler.no_recipient", false);
      }
      if (!draftContent.subject || !draftContent.body) {
        // An empty draft after an approval means something upstream went wrong, and
        // sending a blank email to a customer is worse than failing loudly.
        throw new HandlerError("The approved draft has no subject or body", "handler.empty_draft", false);
      }

      return {
        output: { to, subject: draftContent.subject, queuedAt: now().toISOString() },
        outbox: [
          {
            channel: "email.send",
            payload: { to, subject: draftContent.subject, body: draftContent.body },
            // Keyed on the run and task, not the attempt: a retried task must not send twice.
            idempotencyKey: `email:${task.runId}:${task.key}`,
          },
        ],
      };
    },
  };
}
