import type { WorkflowDefinition, WorkflowContext } from "../domain/types";

/**
 * Accounts-receivable collections.
 *
 * An invoice goes overdue. The harness pulls the facts from Odoo, works out where in the
 * dunning ladder this customer is, has an agent draft a chase, **stops for a human**, and
 * only then sends anything and logs it back to the ERP.
 *
 * The approval gate is the point. Chasing a customer for money is a business
 * relationship, not a database write: an agent that decides on its own to threaten a
 * ten-year client with legal action over a £180 invoice they already disputed costs more
 * than it collects. So the agent drafts and a person signs.
 */

interface InvoiceFacts {
  invoiceNumber: string;
  amountDue: number;
  currency: string;
  daysOverdue: number;
  partnerName: string;
  partnerEmail: string;
  /** Prior chases for this invoice, so the ladder does not restart. */
  previousReminders: number;
  /** Set when the customer has raised a dispute; stops the ladder dead. */
  disputed: boolean;
  /** Total the customer has ever paid us, used to weigh the tone. */
  lifetimeValue: number;
}

function facts(context: WorkflowContext): InvoiceFacts {
  return (context.outputs.fetch_invoice ?? {}) as unknown as InvoiceFacts;
}

/**
 * The dunning ladder.
 *
 * Deliberately data, not prompt text: the escalation policy is a business decision that
 * finance should be able to read and change, and it must not be something a model can
 * drift on between runs.
 */
export const DUNNING_LADDER = [
  { stage: 1, afterDays: 3, tone: "gentle", channel: "email", approvalRoles: ["ar_clerk", "ar_manager"] },
  { stage: 2, afterDays: 14, tone: "firm", channel: "email", approvalRoles: ["ar_clerk", "ar_manager"] },
  { stage: 3, afterDays: 30, tone: "formal", channel: "email", approvalRoles: ["ar_manager"] },
  { stage: 4, afterDays: 60, tone: "final_notice", channel: "email", approvalRoles: ["ar_manager", "finance_director"] },
] as const;

export function stageFor(daysOverdue: number, previousReminders: number): (typeof DUNNING_LADDER)[number] {
  // Never go backwards: a customer who has had three chases does not get the gentle one
  // again because somebody re-dated the invoice.
  const byAge = [...DUNNING_LADDER].reverse().find((step) => daysOverdue >= step.afterDays) ?? DUNNING_LADDER[0];
  const byHistory = DUNNING_LADDER[Math.min(previousReminders, DUNNING_LADDER.length - 1)] ?? DUNNING_LADDER[0];
  return byAge.stage >= byHistory.stage ? byAge : byHistory;
}

/** Above this, a person decides even at stage 1. Large balances are not routine. */
export const HIGH_VALUE_THRESHOLD = 10_000;

export const arCollections: WorkflowDefinition = {
  name: "ar_collections",
  version: 3,
  description: "Chase an overdue invoice through the dunning ladder, with a human approving every message.",
  subjectType: "account.move",
  timeoutHours: 24 * 14,
  tasks: [
    {
      key: "fetch_invoice",
      handler: "odoo.fetch_invoice",
      maxAttempts: 5,
      input: (context) => ({ invoiceId: context.input.invoiceId }),
    },
    {
      key: "assess",
      handler: "agent.ar_assessor",
      dependsOn: ["fetch_invoice"],
      maxAttempts: 3,
      input: (context) => {
        const invoice = facts(context);
        return {
          invoice,
          ladder: stageFor(invoice.daysOverdue, invoice.previousReminders),
          highValue: invoice.amountDue >= HIGH_VALUE_THRESHOLD,
        };
      },
    },
    {
      // A disputed invoice goes to a person, not a chaser. Chasing someone who has
      // already complained is how a collections process turns into a lost customer.
      key: "route_dispute",
      handler: "system.raise_ticket",
      dependsOn: ["assess"],
      when: (context) => facts(context).disputed,
      input: (context) => ({
        queue: "ar_disputes",
        subject: `Disputed invoice ${facts(context).invoiceNumber}`,
        partner: facts(context).partnerName,
      }),
    },
    {
      key: "draft_message",
      handler: "agent.ar_drafter",
      dependsOn: ["assess"],
      maxAttempts: 3,
      when: (context) => !facts(context).disputed,
      input: (context) => ({
        invoice: facts(context),
        assessment: context.outputs.assess ?? {},
      }),
    },
    {
      key: "approve_message",
      handler: "system.approval_gate",
      dependsOn: ["draft_message"],
      when: (context) => !facts(context).disputed,
      approval: {
        summary: (context) => {
          const invoice = facts(context);
          const stage = stageFor(invoice.daysOverdue, invoice.previousReminders);
          return (
            `Send a ${stage.tone.replace("_", " ")} reminder to ${invoice.partnerName} ` +
            `for ${invoice.currency} ${invoice.amountDue.toLocaleString()} on ${invoice.invoiceNumber}, ` +
            `${invoice.daysOverdue} days overdue.`
          );
        },
        requiredRoles: ["ar_clerk", "ar_manager"],
        expiresInHours: 48,
        // Nothing goes out unapproved. An expired approval means the chase does not
        // happen, not that it happens anyway.
        onExpiry: "skip",
      },
    },
    {
      key: "send_message",
      handler: "effect.send_email",
      dependsOn: ["approve_message"],
      maxAttempts: 5,
      input: (context) => ({
        to: facts(context).partnerEmail,
        // The approved draft, not a freshly generated one. Regenerating here would send
        // something nobody signed off.
        draft: context.outputs.approve_message ?? context.outputs.draft_message ?? {},
        invoiceNumber: facts(context).invoiceNumber,
      }),
    },
    {
      key: "log_activity",
      handler: "odoo.log_activity",
      dependsOn: ["send_message"],
      maxAttempts: 5,
      input: (context) => ({
        invoiceId: context.input.invoiceId,
        summary: `Reminder sent (stage ${stageFor(facts(context).daysOverdue, facts(context).previousReminders).stage})`,
        note: String((context.outputs.send_message as { subject?: string })?.subject ?? "Payment reminder"),
      }),
    },
    {
      key: "schedule_followup",
      handler: "system.schedule_run",
      dependsOn: ["log_activity"],
      input: (context) => {
        const invoice = facts(context);
        const stage = stageFor(invoice.daysOverdue, invoice.previousReminders);
        const next = DUNNING_LADDER.find((step) => step.stage === stage.stage + 1);
        return {
          workflow: "ar_collections",
          subjectId: String(context.input.invoiceId),
          // The top of the ladder is the end of the automated process; what happens after
          // a final notice is a decision for a person, not a cron job.
          runAfterDays: next ? next.afterDays - stage.afterDays : null,
          input: { invoiceId: context.input.invoiceId },
        };
      },
    },
  ],
};
