import type { Brain, BrainRequest, BrainResponse } from "./brain";

/**
 * A rules brain over the same contract as the model one.
 *
 * Every judgement it makes is a business rule somebody could have written down, which is
 * exactly what makes it useful as a baseline: if a run behaves differently under the LLM,
 * the difference is the model's contribution and can be evaluated on its own terms.
 *
 * It is also what the hosted console runs on, so the demo needs no API key and costs
 * nothing per visitor.
 */

interface InvoiceFacts {
  amountDue: number;
  daysOverdue: number;
  partnerName: string;
  invoiceNumber: string;
  currency: string;
  previousReminders: number;
  lifetimeValue?: number;
  trust?: string;
}

interface LeadFacts {
  name: string;
  partnerName: string;
  expectedRevenue: number;
  probability: number;
  daysSinceContact: number;
  touchCount: number;
  stage: string;
}

export class RulesBrain implements Brain {
  readonly name = "rules";

  async think<TOutput>(request: BrainRequest<TOutput>): Promise<BrainResponse<TOutput>> {
    const raw = this.decide(request);
    return {
      // Parsed through the same schema the model output goes through, so a rules answer
      // cannot be shaped differently from a model answer.
      output: request.schema.parse(raw.value),
      reasoning: raw.reasoning,
      confidence: raw.confidence,
    };
  }

  private decide(request: BrainRequest<unknown>): { value: unknown; reasoning: string; confidence: number } {
    switch (request.agent) {
      case "ar_assessor":
        return this.assessInvoice(request.facts.invoice as InvoiceFacts);
      case "ar_drafter":
        return this.draftReminder(request.facts as { invoice: InvoiceFacts; assessment: AssessmentOutput });
      case "lead_qualifier":
        return this.qualifyLead(request.facts.lead as LeadFacts);
      case "lead_writer":
        return this.draftOutreach(request.facts as { lead: LeadFacts; assessment: QualificationOutput });
      default:
        return { value: {}, reasoning: `No rule defined for the "${request.agent}" agent`, confidence: 0 };
    }
  }

  /* -------------------------------------------------------------- collections -- */

  private assessInvoice(invoice: InvoiceFacts) {
    const tone = invoice.daysOverdue >= 60 ? "final_notice" : invoice.daysOverdue >= 30 ? "formal" : invoice.daysOverdue >= 14 ? "firm" : "gentle";

    // A long-standing customer who has always paid gets the benefit of the doubt on the
    // first chase. Escalating a ten-year client over a week's delay costs more than it
    // collects.
    const goodHistory = (invoice.lifetimeValue ?? 0) > 50_000 || invoice.trust === "good";
    const softened = goodHistory && invoice.daysOverdue < 30;

    const risk = invoice.daysOverdue >= 60 ? "high" : invoice.daysOverdue >= 30 ? "medium" : "low";

    return {
      value: {
        tone: softened ? "gentle" : tone,
        risk,
        escalate: invoice.daysOverdue >= 60 && !goodHistory,
        suggestPaymentPlan: invoice.amountDue > 10_000 && invoice.daysOverdue >= 30,
      },
      reasoning: [
        `${invoice.currency} ${invoice.amountDue.toLocaleString()} is ${invoice.daysOverdue} days overdue`,
        invoice.previousReminders > 0 ? `${invoice.previousReminders} reminder(s) already sent` : "no reminders yet",
        goodHistory ? "long-standing customer with a good payment record" : "no mitigating history",
      ].join("; "),
      confidence: 0.95,
    };
  }

  private draftReminder(facts: { invoice: InvoiceFacts; assessment: AssessmentOutput }) {
    const { invoice, assessment } = facts;
    const amount = `${invoice.currency} ${invoice.amountDue.toLocaleString()}`;

    const openings: Record<string, string> = {
      gentle: `I hope you are well. This is a friendly reminder that invoice ${invoice.invoiceNumber} for ${amount} became due ${invoice.daysOverdue} days ago.`,
      firm: `Invoice ${invoice.invoiceNumber} for ${amount} is now ${invoice.daysOverdue} days past due. We would appreciate payment this week.`,
      formal: `Our records show invoice ${invoice.invoiceNumber} for ${amount} remains unpaid ${invoice.daysOverdue} days after its due date. Please arrange payment within five working days.`,
      final_notice: `Invoice ${invoice.invoiceNumber} for ${amount} is ${invoice.daysOverdue} days overdue. This is a final reminder before the account is referred for collection.`,
    };

    const body = [
      `Dear ${invoice.partnerName},`,
      "",
      openings[assessment.tone] ?? openings.gentle,
      "",
      assessment.suggestPaymentPlan
        ? "If settling the full amount at once is difficult, we are happy to discuss a payment plan. Reply to this email and we will arrange a call."
        : "If payment is already on its way, please ignore this note.",
      "",
      "If there is a query on this invoice, tell us and we will hold the account while we look into it.",
      "",
      "Kind regards,",
      "Accounts Receivable",
    ].join("\n");

    return {
      value: {
        subject:
          assessment.tone === "final_notice"
            ? `Final reminder: invoice ${invoice.invoiceNumber}`
            : `Invoice ${invoice.invoiceNumber} — ${amount} outstanding`,
        body,
        tone: assessment.tone,
      },
      reasoning: `Drafted a ${assessment.tone.replace("_", " ")} reminder; ${assessment.suggestPaymentPlan ? "offered a payment plan" : "no payment plan offered"}.`,
      confidence: 0.9,
    };
  }

  /* --------------------------------------------------------------------- leads -- */

  private qualifyLead(lead: LeadFacts) {
    // Three signals: is it worth money, is it warm, and have we already tried enough.
    const valuable = lead.expectedRevenue >= 10_000;
    const warm = lead.probability >= 30 && lead.daysSinceContact <= 45;
    const exhausted = lead.touchCount >= 4;

    const recommendation = exhausted ? "close_lost" : warm || valuable ? "follow_up" : "nurture";

    // Confidence is lowest in the middle ground, which is exactly where a person should
    // look. A rules brain that is always certain is a rules brain nobody checks.
    const confidence = exhausted ? 0.9 : warm && valuable ? 0.88 : valuable || warm ? 0.72 : 0.55;

    return {
      value: {
        recommendation,
        confidence,
        reasoning: [
          `${lead.stage}, ${lead.probability}% probability`,
          `${lead.daysSinceContact} days since last contact`,
          `${lead.touchCount} approaches so far`,
        ].join("; "),
        suggestedAngle: valuable ? "value" : warm ? "timing" : "check_in",
      },
      reasoning: exhausted
        ? `Four approaches with no reply. Continuing is not persuasion, it is noise.`
        : `${valuable ? "Worth the effort" : "Low value"}; ${warm ? "still warm" : "gone cold"}.`,
      confidence,
    };
  }

  private draftOutreach(facts: { lead: LeadFacts; assessment: QualificationOutput }) {
    const { lead, assessment } = facts;

    const angles: Record<string, string> = {
      value: `We put together a short outline of what we would propose for ${lead.name}, including rough timings and cost. Worth fifteen minutes to walk you through it?`,
      timing: `You mentioned timing was the open question on ${lead.name}. Our calendar has moved, so if it is still live we could start sooner than we first said.`,
      check_in: `Just checking whether ${lead.name} is still something you are looking at. If the timing has moved, that is completely fine — tell me when to come back.`,
    };

    const body = [
      `Hi ${lead.partnerName.split(" ")[0] ?? "there"},`,
      "",
      angles[assessment.suggestedAngle] ?? angles.check_in,
      "",
      "If it is not going ahead, say so and I will close it off — no hard feelings.",
      "",
      "Best,",
    ].join("\n");

    return {
      value: { subject: `Following up on ${lead.name}`, body, angle: assessment.suggestedAngle },
      reasoning: `Followed up on the "${assessment.suggestedAngle}" angle, with an explicit opt-out.`,
      confidence: 0.85,
    };
  }
}

interface AssessmentOutput {
  tone: string;
  risk: string;
  escalate: boolean;
  suggestPaymentPlan: boolean;
}

interface QualificationOutput {
  recommendation: string;
  confidence: number;
  reasoning: string;
  suggestedAngle: string;
}
