import { XmlRpcFault, XmlRpcTransportError, xmlRpcCall, type XmlRpcValue } from "./xmlrpc";

/**
 * Odoo client.
 *
 * Two endpoints: `/xmlrpc/2/common` to authenticate and `/xmlrpc/2/object` for everything
 * else. The uid from the first is passed to every call of the second, so it is fetched
 * once and cached — Odoo's `authenticate` is a full login and doing it per call is the
 * single easiest way to make an integration slow.
 *
 * The methods here are the ones the workflows actually need. Adding a model means adding
 * a method, not widening a generic escape hatch — a typed surface is the difference
 * between a compile error and a `False` arriving where a record was expected.
 */

export interface OdooConfig {
  url: string;
  db: string;
  username: string;
  /** An API key, ideally, rather than a password. */
  password: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class OdooError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly code: string,
  ) {
    super(message);
    this.name = "OdooError";
  }
}

/* ------------------------------------------------------------------- records ---- */

export interface OdooInvoice {
  id: number;
  invoiceNumber: string;
  amountTotal: number;
  amountDue: number;
  currency: string;
  invoiceDate: string;
  dueDate: string | null;
  daysOverdue: number;
  state: string;
  paymentState: string;
  partnerId: number;
  partnerName: string;
  partnerEmail: string;
  /** Prior reminder activities logged against this invoice. */
  previousReminders: number;
  disputed: boolean;
}

export interface OdooPartner {
  id: number;
  name: string;
  email: string;
  phone: string;
  /** Total invoiced to this partner over all time. */
  lifetimeValue: number;
  creditLimit: number;
  /** Odoo's own trust flag: good, normal or bad payer. */
  trust: string;
}

export interface OdooLead {
  id: number;
  name: string;
  partnerName: string;
  email: string;
  phone: string;
  expectedRevenue: number;
  probability: number;
  currency: string;
  stage: string;
  daysSinceContact: number;
  touchCount: number;
  optedOut: boolean;
  salespersonId: number | null;
}

/* -------------------------------------------------------------------- client ---- */

export class OdooClient {
  private uid: number | null = null;
  private authenticating: Promise<number> | null = null;

  constructor(private readonly config: OdooConfig) {}

  static fromEnv(env: Record<string, string | undefined> = process.env): OdooClient | null {
    const url = env.ODOO_URL;
    const db = env.ODOO_DB;
    const username = env.ODOO_USERNAME;
    const password = env.ODOO_PASSWORD ?? env.ODOO_API_KEY;
    if (!url || !db || !username || !password) return null;
    return new OdooClient({ url, db, username, password });
  }

  /**
   * Log in, once.
   *
   * Concurrent callers share the in-flight promise rather than each opening their own
   * session; a worker starting ten tasks at once otherwise logs in ten times.
   */
  async authenticate(): Promise<number> {
    if (this.uid !== null) return this.uid;
    if (this.authenticating) return this.authenticating;

    this.authenticating = (async () => {
      const result = await this.call(`${this.config.url}/xmlrpc/2/common`, "authenticate", [
        this.config.db,
        this.config.username,
        this.config.password,
        {},
      ]);

      // Odoo returns `false`, not an error, when the credentials are wrong.
      if (typeof result !== "number" || result === 0) {
        throw new OdooError(
          `Odoo rejected the credentials for ${this.config.username} on ${this.config.db}`,
          false,
          "odoo.unauthorised",
        );
      }
      this.uid = result;
      return result;
    })();

    try {
      return await this.authenticating;
    } finally {
      this.authenticating = null;
    }
  }

  /** `execute_kw`, the one call everything else is built on. */
  async execute(model: string, method: string, args: XmlRpcValue[], kwargs: Record<string, XmlRpcValue> = {}) {
    const uid = await this.authenticate();
    return this.call(`${this.config.url}/xmlrpc/2/object`, "execute_kw", [
      this.config.db,
      uid,
      this.config.password,
      model,
      method,
      args,
      kwargs,
    ]);
  }

  async searchRead<T = Record<string, XmlRpcValue>>(
    model: string,
    domain: XmlRpcValue[],
    fields: string[],
    options: { limit?: number; offset?: number; order?: string } = {},
  ): Promise<T[]> {
    const result = await this.execute(model, "search_read", [domain], {
      fields,
      limit: options.limit ?? 100,
      offset: options.offset ?? 0,
      ...(options.order ? { order: options.order } : {}),
    });
    return (Array.isArray(result) ? result : []) as T[];
  }

  /* ------------------------------------------------------------- invoices -- */

  async fetchInvoice(invoiceId: number, today = new Date()): Promise<OdooInvoice> {
    const [record] = await this.searchRead<InvoiceRow>(
      "account.move",
      [["id", "=", invoiceId]],
      [
        "name",
        "amount_total",
        "amount_residual",
        "currency_id",
        "invoice_date",
        "invoice_date_due",
        "state",
        "payment_state",
        "partner_id",
      ],
      { limit: 1 },
    );

    if (!record) {
      // Not retryable: the invoice is not going to appear on a second attempt.
      throw new OdooError(`No invoice with id ${invoiceId}`, false, "odoo.not_found");
    }

    const partnerId = relationId(record.partner_id);
    const partner = partnerId ? await this.fetchPartner(partnerId) : null;

    const due = typeof record.invoice_date_due === "string" ? record.invoice_date_due : null;
    const daysOverdue = due
      ? Math.max(0, Math.floor((today.getTime() - new Date(`${due}T00:00:00Z`).getTime()) / 86_400_000))
      : 0;

    const activities = await this.countReminders(invoiceId);

    return {
      id: invoiceId,
      invoiceNumber: asString(record.name),
      amountTotal: asNumber(record.amount_total),
      amountDue: asNumber(record.amount_residual),
      currency: relationName(record.currency_id) ?? "EUR",
      invoiceDate: asString(record.invoice_date),
      dueDate: due,
      daysOverdue,
      state: asString(record.state),
      paymentState: asString(record.payment_state),
      partnerId: partnerId ?? 0,
      partnerName: partner?.name ?? relationName(record.partner_id) ?? "Unknown",
      partnerEmail: partner?.email ?? "",
      previousReminders: activities.reminders,
      disputed: activities.disputed,
    };
  }

  /**
   * Invoices that are overdue and still owe money.
   *
   * `payment_state != paid` matters as much as the date: a paid invoice with a due date in
   * the past is not a collections candidate, and chasing one is the fastest way to lose
   * the finance team's trust in the whole system.
   */
  async findOverdueInvoices(params: { minDaysOverdue?: number; limit?: number; today?: Date } = {}): Promise<number[]> {
    const today = params.today ?? new Date();
    const cutoff = new Date(today.getTime() - (params.minDaysOverdue ?? 1) * 86_400_000).toISOString().slice(0, 10);

    const rows = await this.searchRead<{ id: number }>(
      "account.move",
      [
        ["move_type", "=", "out_invoice"],
        ["state", "=", "posted"],
        ["payment_state", "in", ["not_paid", "partial"]],
        ["invoice_date_due", "<=", cutoff],
      ],
      ["id"],
      { limit: params.limit ?? 100, order: "invoice_date_due asc" },
    );
    return rows.map((row) => row.id);
  }

  private async countReminders(invoiceId: number): Promise<{ reminders: number; disputed: boolean }> {
    const rows = await this.searchRead<{ summary: XmlRpcValue; note: XmlRpcValue }>(
      "mail.message",
      [
        ["model", "=", "account.move"],
        ["res_id", "=", invoiceId],
      ],
      ["summary", "note", "body"],
      { limit: 50 },
    );

    let reminders = 0;
    let disputed = false;
    for (const row of rows) {
      const text = `${asString(row.summary)} ${asString(row.note)}`.toLowerCase();
      if (text.includes("reminder") || text.includes("dunning")) reminders++;
      // A customer who has queried an invoice must not be chased by a bot.
      if (text.includes("dispute") || text.includes("query") || text.includes("contested")) disputed = true;
    }
    return { reminders, disputed };
  }

  /* -------------------------------------------------------------- partners -- */

  async fetchPartner(partnerId: number): Promise<OdooPartner | null> {
    const [record] = await this.searchRead<PartnerRow>(
      "res.partner",
      [["id", "=", partnerId]],
      ["name", "email", "phone", "credit_limit", "total_invoiced", "trust"],
      { limit: 1 },
    );
    if (!record) return null;

    return {
      id: partnerId,
      name: asString(record.name),
      email: asString(record.email),
      phone: asString(record.phone),
      lifetimeValue: asNumber(record.total_invoiced),
      creditLimit: asNumber(record.credit_limit),
      trust: asString(record.trust) || "normal",
    };
  }

  /* ----------------------------------------------------------------- leads -- */

  async fetchLead(leadId: number, today = new Date()): Promise<OdooLead> {
    const [record] = await this.searchRead<LeadRow>(
      "crm.lead",
      [["id", "=", leadId]],
      [
        "name",
        "partner_name",
        "email_from",
        "phone",
        "expected_revenue",
        "probability",
        "company_currency",
        "stage_id",
        "date_last_stage_update",
        "user_id",
        "message_bounce",
      ],
      { limit: 1 },
    );

    if (!record) throw new OdooError(`No lead with id ${leadId}`, false, "odoo.not_found");

    const lastTouch = record.date_last_stage_update;
    const daysSinceContact =
      typeof lastTouch === "string"
        ? Math.max(0, Math.floor((today.getTime() - new Date(`${lastTouch}Z`).getTime()) / 86_400_000))
        : 0;

    const touches = await this.searchRead<{ id: number }>(
      "mail.message",
      [
        ["model", "=", "crm.lead"],
        ["res_id", "=", leadId],
        ["message_type", "=", "email"],
      ],
      ["id"],
      { limit: 50 },
    );

    return {
      id: leadId,
      name: asString(record.name),
      partnerName: asString(record.partner_name) || asString(record.name),
      email: asString(record.email_from),
      phone: asString(record.phone),
      expectedRevenue: asNumber(record.expected_revenue),
      probability: asNumber(record.probability),
      currency: relationName(record.company_currency) ?? "EUR",
      stage: relationName(record.stage_id) ?? "New",
      daysSinceContact,
      touchCount: touches.length,
      // A bounced address is an opt-out in practice; continuing to mail it damages the
      // sending domain for everyone else.
      optedOut: asNumber(record.message_bounce) > 0,
      salespersonId: relationId(record.user_id),
    };
  }

  /* --------------------------------------------------------------- writes -- */

  /**
   * Log an activity against a record.
   *
   * This is how the ERP learns what the harness did. Without it, a finance user looking at
   * an invoice in Odoo has no idea a reminder went out, and chases it again by hand.
   */
  async logActivity(params: {
    model: string;
    recordId: number;
    summary: string;
    note: string;
    userId?: number;
  }): Promise<number> {
    const result = await this.execute("mail.message", "create", [
      {
        model: params.model,
        res_id: params.recordId,
        body: params.note,
        subject: params.summary,
        message_type: "comment",
        subtype_id: 1,
      },
    ]);
    return typeof result === "number" ? result : 0;
  }

  async updateLead(leadId: number, values: Record<string, XmlRpcValue>): Promise<boolean> {
    const result = await this.execute("crm.lead", "write", [[leadId], values]);
    return result === true;
  }

  async scheduleActivity(params: {
    model: string;
    recordId: number;
    summary: string;
    dueDate: string;
    userId: number;
  }): Promise<number> {
    const modelId = await this.execute("ir.model", "search", [[["model", "=", params.model]]], { limit: 1 });
    const resModelId = Array.isArray(modelId) && typeof modelId[0] === "number" ? modelId[0] : null;

    const result = await this.execute("mail.activity", "create", [
      {
        res_model_id: resModelId,
        res_id: params.recordId,
        summary: params.summary,
        date_deadline: params.dueDate,
        user_id: params.userId,
      },
    ]);
    return typeof result === "number" ? result : 0;
  }

  /* ------------------------------------------------------------ internals -- */

  private async call(url: string, method: string, params: XmlRpcValue[]): Promise<XmlRpcValue> {
    try {
      return await xmlRpcCall({
        url,
        method,
        params,
        ...(this.config.timeoutMs !== undefined ? { timeoutMs: this.config.timeoutMs } : {}),
        ...(this.config.fetchImpl ? { fetchImpl: this.config.fetchImpl } : {}),
      });
    } catch (error) {
      if (error instanceof OdooError) throw error;

      if (error instanceof XmlRpcFault) {
        // Odoo puts everything in faultString, so the classification has to read it.
        const text = error.faultString.toLowerCase();
        if (text.includes("access denied") || text.includes("session expired")) {
          // Force a fresh login on the next call rather than looping on a dead session.
          this.uid = null;
          throw new OdooError(error.faultString, true, "odoo.session_expired");
        }
        if (text.includes("accesserror") || text.includes("not allowed")) {
          throw new OdooError(error.faultString, false, "odoo.forbidden");
        }
        if (text.includes("does not exist") || text.includes("missingerror")) {
          throw new OdooError(error.faultString, false, "odoo.not_found");
        }
        if (text.includes("serializationfailure") || text.includes("concurrent update")) {
          // Odoo serialises some writes and asks the caller to try again.
          throw new OdooError(error.faultString, true, "odoo.serialization");
        }
        throw new OdooError(error.faultString, false, "odoo.fault");
      }

      if (error instanceof XmlRpcTransportError) {
        const retryable = error.status === undefined || error.status >= 500 || error.status === 429;
        throw new OdooError(error.message, retryable, `odoo.transport.${error.status ?? "network"}`);
      }

      throw new OdooError(error instanceof Error ? error.message : String(error), false, "odoo.unknown");
    }
  }
}

/* ------------------------------------------------------------------ helpers ---- */

/** Odoo returns a many2one as `[id, display_name]`, or `false` when it is not set. */
function relationId(value: XmlRpcValue): number | null {
  return Array.isArray(value) && typeof value[0] === "number" ? value[0] : null;
}

function relationName(value: XmlRpcValue): string | null {
  return Array.isArray(value) && typeof value[1] === "string" ? value[1] : null;
}

/** Odoo uses `false` for an empty string, which JavaScript happily renders as "false". */
function asString(value: XmlRpcValue): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: XmlRpcValue): number {
  return typeof value === "number" ? value : 0;
}

interface InvoiceRow {
  name: XmlRpcValue;
  amount_total: XmlRpcValue;
  amount_residual: XmlRpcValue;
  currency_id: XmlRpcValue;
  invoice_date: XmlRpcValue;
  invoice_date_due: XmlRpcValue;
  state: XmlRpcValue;
  payment_state: XmlRpcValue;
  partner_id: XmlRpcValue;
}

interface PartnerRow {
  name: XmlRpcValue;
  email: XmlRpcValue;
  phone: XmlRpcValue;
  credit_limit: XmlRpcValue;
  total_invoiced: XmlRpcValue;
  trust: XmlRpcValue;
}

interface LeadRow {
  name: XmlRpcValue;
  partner_name: XmlRpcValue;
  email_from: XmlRpcValue;
  phone: XmlRpcValue;
  expected_revenue: XmlRpcValue;
  probability: XmlRpcValue;
  company_currency: XmlRpcValue;
  stage_id: XmlRpcValue;
  date_last_stage_update: XmlRpcValue;
  user_id: XmlRpcValue;
  message_bounce: XmlRpcValue;
}
