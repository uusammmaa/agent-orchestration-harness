import { decodeResponse, encodeRequest, type XmlRpcValue } from "./xmlrpc";

/**
 * A stub Odoo, good enough to test against.
 *
 * It speaks real XML-RPC over a `fetch` you can hand to `OdooClient`, so the client's
 * encoder, decoder, auth caching and error classification are all exercised for real. A
 * hand-mocked client would skip exactly the layer most likely to be wrong.
 *
 * It also fails on demand, which is how the retry and quarantine paths get covered
 * without waiting for a real Odoo to have a bad day.
 */

export interface StubRecord {
  id: number;
  [field: string]: XmlRpcValue;
}

export type StubFault = { code: number; message: string } | null;

export interface StubOptions {
  db?: string;
  username?: string;
  password?: string;
  uid?: number;
}

export class OdooStub {
  readonly calls: Array<{ model: string; method: string; args: XmlRpcValue[] }> = [];
  private readonly models = new Map<string, StubRecord[]>();
  private nextId = 1000;

  /** Set to make the next N calls fail. Cleared as it counts down. */
  failNext = 0;
  failWith: StubFault = null;
  /** Set to make every call fail until cleared. */
  failAlways: StubFault = null;

  constructor(private readonly options: StubOptions = {}) {}

  seed(model: string, records: StubRecord[]): void {
    this.models.set(model, records.map((record) => ({ ...record })));
    for (const record of records) this.nextId = Math.max(this.nextId, record.id + 1);
  }

  records(model: string): StubRecord[] {
    return this.models.get(model) ?? [];
  }

  reset(): void {
    this.models.clear();
    this.calls.length = 0;
    this.failNext = 0;
    this.failWith = null;
    this.failAlways = null;
  }

  /** Hand this to `OdooClient` as `fetchImpl`. */
  get fetch(): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const body = typeof init?.body === "string" ? init.body : "";
      const { method, params } = parseRequest(body);

      const fault = this.nextFault();
      if (fault) return xmlResponse(faultXml(fault.code, fault.message));

      if (url.endsWith("/xmlrpc/2/common")) {
        return xmlResponse(this.handleCommon(method, params));
      }
      if (url.endsWith("/xmlrpc/2/object")) {
        return xmlResponse(this.handleObject(params));
      }
      return new Response("Not found", { status: 404 });
    }) as typeof fetch;
  }

  private nextFault(): { code: number; message: string } | null {
    if (this.failAlways) return this.failAlways;
    if (this.failNext > 0) {
      this.failNext -= 1;
      return this.failWith ?? { code: 3, message: "Odoo Server Error: temporary failure" };
    }
    return null;
  }

  private handleCommon(method: string, params: XmlRpcValue[]): string {
    if (method !== "authenticate") return responseXml(false);

    const [db, username, password] = params as [string, string, string];
    const ok =
      db === (this.options.db ?? "harness") &&
      username === (this.options.username ?? "bot@example.com") &&
      password === (this.options.password ?? "secret");

    // Odoo returns `false` rather than a fault for bad credentials.
    return responseXml(ok ? (this.options.uid ?? 7) : false);
  }

  private handleObject(params: XmlRpcValue[]): string {
    const [, , , model, method, args, kwargs] = params as [
      string,
      number,
      string,
      string,
      string,
      XmlRpcValue[],
      Record<string, XmlRpcValue>,
    ];
    this.calls.push({ model, method, args });

    switch (method) {
      case "search_read":
        return responseXml(this.searchRead(model, args[0] as XmlRpcValue[], kwargs));
      case "search":
        return responseXml(
          this.match(model, args[0] as XmlRpcValue[]).map((record) => record.id),
        );
      case "create": {
        const values = (args[0] ?? {}) as Record<string, XmlRpcValue>;
        const record: StubRecord = { id: this.nextId++, ...values };
        this.models.set(model, [...this.records(model), record]);
        return responseXml(record.id);
      }
      case "write": {
        const ids = (args[0] ?? []) as number[];
        const values = (args[1] ?? {}) as Record<string, XmlRpcValue>;
        const updated = this.records(model).map((record) =>
          ids.includes(record.id) ? { ...record, ...values } : record,
        );
        this.models.set(model, updated);
        return responseXml(true);
      }
      default:
        return faultXml(2, `Stub does not implement ${model}.${method}`);
    }
  }

  private searchRead(
    model: string,
    domain: XmlRpcValue[],
    kwargs: Record<string, XmlRpcValue>,
  ): XmlRpcValue[] {
    const fields = (kwargs.fields as string[] | undefined) ?? [];
    const limit = typeof kwargs.limit === "number" ? kwargs.limit : 100;

    return this.match(model, domain)
      .slice(0, limit)
      .map((record) => {
        if (fields.length === 0) return record;
        const projected: Record<string, XmlRpcValue> = { id: record.id };
        for (const field of fields) {
          // Odoo omits nothing: an unset field comes back as `false`, and code that does
          // not expect that is code that renders "false" to a customer.
          projected[field] = record[field] ?? false;
        }
        return projected;
      });
  }

  /** Enough of Odoo's domain language for the queries this codebase makes. */
  private match(model: string, domain: XmlRpcValue[]): StubRecord[] {
    return this.records(model).filter((record) =>
      domain.every((clause) => {
        if (!Array.isArray(clause) || clause.length !== 3) return true;
        const [field, operator, expected] = clause as [string, string, XmlRpcValue];
        const actual = record[field];

        // An absent field is Odoo's `false`, not undefined; comparisons must see that.
        const value: XmlRpcValue = actual === undefined ? false : actual;

        switch (operator) {
          case "=":
            return value === expected;
          case "!=":
            return value !== expected;
          case "in":
            return Array.isArray(expected) && expected.includes(value as never);
          case "not in":
            return Array.isArray(expected) && !expected.includes(value as never);
          case "<=":
            return compare(value, expected) <= 0;
          case "<":
            return compare(value, expected) < 0;
          case ">=":
            return compare(value, expected) >= 0;
          case ">":
            return compare(value, expected) > 0;
          case "ilike":
            return String(value).toLowerCase().includes(String(expected).toLowerCase());
          default:
            return true;
        }
      }),
    );
  }
}

function compare(a: XmlRpcValue, b: XmlRpcValue): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

function parseRequest(body: string): { method: string; params: XmlRpcValue[] } {
  const method = body.match(/<methodName>([^<]*)<\/methodName>/)?.[1] ?? "";
  // Reuse the response decoder by wrapping the params the way a response would carry them.
  const paramsXml = body.slice(body.indexOf("<params>"), body.lastIndexOf("</params>") + "</params>".length);
  const wrapped = `<?xml version="1.0"?><methodResponse><params><param><value><array><data>${stripParamTags(
    paramsXml,
  )}</data></array></value></param></params></methodResponse>`;
  const decoded = decodeResponse(wrapped);
  return { method, params: Array.isArray(decoded) ? decoded : [] };
}

function stripParamTags(paramsXml: string): string {
  return paramsXml
    .replace(/<\/?params>/g, "")
    .replace(/<param>/g, "")
    .replace(/<\/param>/g, "");
}

function responseXml(value: XmlRpcValue): string {
  // encodeRequest emits <value> blocks; reuse it and relabel the envelope.
  const encoded = encodeRequest("x", [value]).match(/<params>(.*)<\/params>/s)?.[1] ?? "";
  return `<?xml version="1.0"?><methodResponse><params>${encoded}</params></methodResponse>`;
}

function faultXml(code: number, message: string): string {
  return (
    `<?xml version="1.0"?><methodResponse><fault><value><struct>` +
    `<member><name>faultCode</name><value><int>${code}</int></value></member>` +
    `<member><name>faultString</name><value><string>${message.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</string></value></member>` +
    `</struct></value></fault></methodResponse>`
  );
}

function xmlResponse(xml: string): Response {
  return new Response(xml, { status: 200, headers: { "content-type": "text/xml" } });
}

/* ------------------------------------------------------------------ fixtures ---- */

/** A small, realistic Odoo, seeded for the demo and the tests. */
export function seedStub(stub: OdooStub, today = new Date("2026-09-19T09:00:00.000Z")): void {
  const daysAgo = (days: number) => new Date(today.getTime() - days * 86_400_000).toISOString().slice(0, 10);

  stub.seed("res.partner", [
    { id: 11, name: "Harrow & Finch Ltd", email: "ap@harrowfinch.example", phone: "+44 20 7946 0102", total_invoiced: 184_000, credit_limit: 50_000, trust: "good" },
    { id: 12, name: "Northgate Coffee", email: "accounts@northgate.example", phone: "+44 161 496 0119", total_invoiced: 21_400, credit_limit: 10_000, trust: "normal" },
    { id: 13, name: "Pellow Architects", email: "finance@pellow.example", phone: "+44 131 496 0733", total_invoiced: 96_500, credit_limit: 40_000, trust: "normal" },
    { id: 14, name: "Silverline Gin", email: "toby@silverlinegin.example", phone: "+44 117 496 0221", total_invoiced: 8_900, credit_limit: 5_000, trust: "bad" },
  ]);

  stub.seed("account.move", [
    {
      id: 5001,
      name: "INV/2026/0417",
      move_type: "out_invoice",
      state: "posted",
      payment_state: "not_paid",
      amount_total: 4_250,
      amount_residual: 4_250,
      currency_id: [1, "GBP"],
      invoice_date: daysAgo(38),
      invoice_date_due: daysAgo(8),
      partner_id: [11, "Harrow & Finch Ltd"],
    },
    {
      id: 5002,
      name: "INV/2026/0422",
      move_type: "out_invoice",
      state: "posted",
      payment_state: "partial",
      amount_total: 12_800,
      amount_residual: 6_400,
      currency_id: [1, "GBP"],
      invoice_date: daysAgo(70),
      invoice_date_due: daysAgo(40),
      partner_id: [13, "Pellow Architects"],
    },
    {
      id: 5003,
      name: "INV/2026/0431",
      move_type: "out_invoice",
      state: "posted",
      payment_state: "not_paid",
      amount_total: 1_950,
      amount_residual: 1_950,
      currency_id: [1, "GBP"],
      invoice_date: daysAgo(20),
      invoice_date_due: daysAgo(4),
      partner_id: [14, "Silverline Gin"],
    },
    {
      // Paid, and due in the past. Must never be picked up.
      id: 5004,
      name: "INV/2026/0402",
      move_type: "out_invoice",
      state: "posted",
      payment_state: "paid",
      amount_total: 3_100,
      amount_residual: 0,
      currency_id: [1, "GBP"],
      invoice_date: daysAgo(90),
      invoice_date_due: daysAgo(60),
      partner_id: [12, "Northgate Coffee"],
    },
  ]);

  stub.seed("mail.message", [
    { id: 9001, model: "account.move", res_id: 5001, summary: "Payment reminder sent", note: "Stage 1 reminder", message_type: "comment" },
    { id: 9002, model: "account.move", res_id: 5002, summary: "Payment reminder sent", note: "Stage 1 reminder", message_type: "comment" },
    { id: 9003, model: "account.move", res_id: 5002, summary: "Payment reminder sent", note: "Stage 2 reminder", message_type: "comment" },
    // Silverline queried their invoice. The workflow must route this to a person.
    { id: 9004, model: "account.move", res_id: 5003, summary: "Customer dispute raised", note: "Customer disputes the delivery date", message_type: "comment" },
  ]);

  stub.seed("crm.lead", [
    {
      id: 7001,
      name: "Rebrand and launch film",
      partner_name: "Calder Brewing",
      email_from: "ops@calderbrewing.example",
      phone: "+44 113 496 0044",
      expected_revenue: 42_000,
      probability: 45,
      company_currency: [1, "GBP"],
      stage_id: [3, "Proposition"],
      date_last_stage_update: "2026-08-21 10:15:00",
      user_id: [5, "Nadia Okoro"],
      message_bounce: 0,
    },
    {
      id: 7002,
      name: "Seasonal social package",
      partner_name: "Wren & Vale",
      email_from: "hello@wrenvale.example",
      phone: "",
      expected_revenue: 6_500,
      probability: 25,
      company_currency: [1, "GBP"],
      stage_id: [2, "Qualified"],
      date_last_stage_update: "2026-09-02 14:40:00",
      user_id: [6, "Joel Ibarra"],
      message_bounce: 0,
    },
    {
      id: 7003,
      name: "Product photography retainer",
      partner_name: "Hollis Foods",
      email_from: "bounced@hollisfoods.example",
      phone: "",
      expected_revenue: 18_000,
      probability: 10,
      company_currency: [1, "GBP"],
      stage_id: [2, "Qualified"],
      date_last_stage_update: "2026-07-14 09:05:00",
      user_id: [5, "Nadia Okoro"],
      message_bounce: 3,
    },
  ]);

  stub.seed("ir.model", [
    { id: 201, model: "account.move" },
    { id: 202, model: "crm.lead" },
  ]);
}
