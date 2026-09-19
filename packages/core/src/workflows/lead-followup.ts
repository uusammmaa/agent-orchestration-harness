import type { WorkflowContext, WorkflowDefinition } from "../domain/types";

/**
 * Lead follow-up.
 *
 * A lead goes quiet. The harness enriches it from the CRM, an agent decides whether it is
 * worth chasing and drafts something, and — unlike collections — only *some* of those go
 * to a human.
 *
 * The difference is deliberate and is the interesting part of having two workflows. A
 * dunning letter always needs sign-off because it is a financial and legal act. A
 * follow-up email to a £2,000 lead does not, and putting a person in that loop means the
 * queue fills with rubber-stamps and the approvals that matter stop getting read.
 *
 * So: value above a threshold, or a named account, or an agent that is unsure, goes to a
 * person. Everything else sends.
 */

interface LeadFacts {
  /** Odoo's own field name. `fetchLead` returns `id`, so this must match it. */
  id: number;
  name: string;
  partnerName: string;
  email: string;
  expectedRevenue: number;
  currency: string;
  stage: string;
  daysSinceContact: number;
  touchCount: number;
  namedAccount: boolean;
  optedOut: boolean;
}

interface Assessment {
  recommendation: "follow_up" | "nurture" | "close_lost";
  confidence: number;
  reasoning: string;
}

function lead(context: WorkflowContext): LeadFacts {
  return (context.outputs.fetch_lead ?? {}) as unknown as LeadFacts;
}

function assessment(context: WorkflowContext): Assessment {
  return (context.outputs.qualify ?? { recommendation: "nurture", confidence: 0 }) as unknown as Assessment;
}

/** Above this, or a named account, a person reads it before it goes. */
export const REVIEW_THRESHOLD = 25_000;
/** Below this confidence the agent is guessing, so a person decides. */
export const CONFIDENCE_FLOOR = 0.7;
/** Past this many touches without a reply, stop. Persistence stops being persuasion. */
export const MAX_TOUCHES = 4;

export function needsHumanReview(facts: LeadFacts, judgement: Assessment): boolean {
  if (facts.namedAccount) return true;
  if (facts.expectedRevenue >= REVIEW_THRESHOLD) return true;
  if (judgement.confidence < CONFIDENCE_FLOOR) return true;
  if (judgement.recommendation === "close_lost") return true;
  return false;
}

export const leadFollowup: WorkflowDefinition = {
  name: "lead_followup",
  version: 2,
  description: "Re-engage a stalled lead, with human review only where the stakes or the uncertainty justify it.",
  subjectType: "crm.lead",
  timeoutHours: 24 * 7,
  tasks: [
    {
      key: "fetch_lead",
      handler: "odoo.fetch_lead",
      maxAttempts: 5,
      input: (context) => ({ leadId: context.input.leadId }),
    },
    {
      key: "qualify",
      handler: "agent.lead_qualifier",
      dependsOn: ["fetch_lead"],
      maxAttempts: 3,
      // Somebody who has opted out is not a lead, and touching them is a compliance
      // problem rather than a missed opportunity.
      when: (context) => !lead(context).optedOut && lead(context).touchCount < MAX_TOUCHES,
      input: (context) => ({ lead: lead(context) }),
    },
    {
      key: "mark_exhausted",
      handler: "odoo.update_lead",
      dependsOn: ["fetch_lead"],
      when: (context) => lead(context).touchCount >= MAX_TOUCHES && !lead(context).optedOut,
      input: (context) => ({
        leadId: lead(context).id,
        stage: "Nurture",
        note: `No reply after ${lead(context).touchCount} approaches. Moved to nurture rather than chased again.`,
      }),
    },
    {
      key: "draft_outreach",
      handler: "agent.lead_writer",
      dependsOn: ["qualify"],
      maxAttempts: 3,
      when: (context) => assessment(context).recommendation === "follow_up",
      input: (context) => ({ lead: lead(context), assessment: assessment(context) }),
    },
    {
      key: "review_outreach",
      handler: "system.approval_gate",
      dependsOn: ["draft_outreach"],
      when: (context) => needsHumanReview(lead(context), assessment(context)),
      approval: {
        summary: (context) => {
          const facts = lead(context);
          const judgement = assessment(context);
          const why = facts.namedAccount
            ? "named account"
            : facts.expectedRevenue >= REVIEW_THRESHOLD
              ? `${facts.currency} ${facts.expectedRevenue.toLocaleString()} opportunity`
              : `the agent is only ${Math.round(judgement.confidence * 100)}% confident`;
          return `Send a follow-up to ${facts.partnerName} about "${facts.name}" — flagged because of ${why}.`;
        },
        requiredRoles: ["sales_rep", "sales_manager"],
        expiresInHours: 72,
        // Unlike collections: a follow-up nobody got round to reading is a missed email,
        // not a compliance incident. Skipping is the proportionate response.
        onExpiry: "skip",
      },
    },
    {
      key: "send_outreach",
      handler: "effect.send_email",
      // The draft must exist; the review gate need only have settled. That asymmetry is
      // the whole point of this workflow - review is conditional here, unlike collections.
      requires: ["draft_outreach"],
      dependsOn: ["review_outreach"],
      maxAttempts: 5,
      when: (context) => assessment(context).recommendation === "follow_up" && !lead(context).optedOut,
      input: (context) => ({
        to: lead(context).email,
        draft: context.outputs.review_outreach ?? context.outputs.draft_outreach ?? {},
        leadId: lead(context).id,
      }),
    },
    {
      key: "record_touch",
      handler: "odoo.log_activity",
      dependsOn: ["send_outreach"],
      maxAttempts: 5,
      input: (context) => ({
        model: "crm.lead",
        recordId: lead(context).id,
        summary: "Follow-up sent",
        note: assessment(context).reasoning,
      }),
    },
  ],
};
