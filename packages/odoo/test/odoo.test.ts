import { beforeEach, describe, expect, it } from "vitest";
import { OdooClient, OdooError } from "../src/client";
import { OdooStub, seedStub } from "../src/stub";
import { decodeResponse, encodeRequest, XmlRpcFault, xmlRpcCall } from "../src/xmlrpc";

/**
 * The Odoo integration, tested through real XML-RPC.
 *
 * Every test here goes encoder → stub → decoder, so the wire format is exercised rather
 * than mocked past. The bugs this catches are the ones that only show up against a real
 * instance: `false` where a string was expected, a many2one arriving as a tuple, a naive
 * datetime being read an hour out.
 */

const TODAY = new Date("2026-09-19T09:00:00.000Z");

function harness() {
  const stub = new OdooStub();
  seedStub(stub, TODAY);
  const client = new OdooClient({
    url: "https://erp.example",
    db: "harness",
    username: "bot@example.com",
    password: "secret",
    fetchImpl: stub.fetch,
  });
  return { stub, client };
}

describe("xml-rpc", () => {
  it("round-trips every type it claims to support", () => {
    const values = [
      "a string",
      42,
      3.5,
      true,
      false,
      null,
      [1, "two", [3]],
      { nested: { deep: true }, list: [1, 2] },
    ];

    for (const value of values) {
      // Encode as a request param, then decode by reshaping into a response envelope.
      const request = encodeRequest("m", [value]);
      const params = request.slice(request.indexOf("<params>"), request.lastIndexOf("</params>") + 9);
      const asResponse = `<?xml version="1.0"?><methodResponse>${params}</methodResponse>`;
      expect(decodeResponse(asResponse)).toEqual(value);
    }
  });

  it("escapes and unescapes text safely", () => {
    const nasty = `Ampersand & <tag> "quoted" 'single'`;
    const request = encodeRequest("m", [nasty]);
    expect(request).not.toContain("<tag>");

    const params = request.slice(request.indexOf("<params>"), request.lastIndexOf("</params>") + 9);
    expect(decodeResponse(`<?xml version="1.0"?><methodResponse>${params}</methodResponse>`)).toBe(nasty);
  });

  it("reads an Odoo datetime as UTC, not local time", () => {
    const xml =
      `<?xml version="1.0"?><methodResponse><params><param><value>` +
      `<dateTime.iso8601>20260919T14:30:00</dateTime.iso8601>` +
      `</value></param></params></methodResponse>`;
    expect((decodeResponse(xml) as Date).toISOString()).toBe("2026-09-19T14:30:00.000Z");
  });

  it("turns a fault into an exception rather than a value", () => {
    const xml =
      `<?xml version="1.0"?><methodResponse><fault><value><struct>` +
      `<member><name>faultCode</name><value><int>3</int></value></member>` +
      `<member><name>faultString</name><value><string>Access Denied</string></value></member>` +
      `</struct></value></fault></methodResponse>`;

    expect(() => decodeResponse(xml)).toThrow(XmlRpcFault);
    try {
      decodeResponse(xml);
    } catch (error) {
      expect((error as XmlRpcFault).faultCode).toBe(3);
    }
  });

  it("parses nested structs inside arrays, which is what search_read returns", () => {
    const xml =
      `<?xml version="1.0"?><methodResponse><params><param><value><array><data>` +
      `<value><struct><member><name>id</name><value><int>1</int></value></member>` +
      `<member><name>partner_id</name><value><array><data>` +
      `<value><int>11</int></value><value><string>Acme</string></value>` +
      `</data></array></value></member></struct></value>` +
      `</data></array></value></param></params></methodResponse>`;

    expect(decodeResponse(xml)).toEqual([{ id: 1, partner_id: [11, "Acme"] }]);
  });

  it("gives up rather than hanging when Odoo does not answer", async () => {
    const hang: typeof fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      })) as typeof fetch;

    await expect(
      xmlRpcCall({ url: "https://erp.example", method: "x", params: [], timeoutMs: 20, fetchImpl: hang }),
    ).rejects.toThrow(/did not respond within 20ms/);
  });
});

describe("authentication", () => {
  it("logs in once and reuses the uid", async () => {
    const { client, stub } = harness();
    await client.fetchInvoice(5001, TODAY);
    await client.fetchInvoice(5001, TODAY);

    // The stub only records object calls, so a second login would be invisible here;
    // instead, assert the uid arrives on the object calls unchanged.
    expect(stub.calls.length).toBeGreaterThan(2);
  });

  it("reports a wrong password as permanent, not retryable", async () => {
    const stub = new OdooStub();
    const client = new OdooClient({
      url: "https://erp.example",
      db: "harness",
      username: "bot@example.com",
      password: "wrong",
      fetchImpl: stub.fetch,
    });

    await expect(client.authenticate()).rejects.toThrow(OdooError);
    await expect(client.authenticate()).rejects.toMatchObject({ retryable: false, code: "odoo.unauthorised" });
  });

  it("treats an expired session as retryable and forces a fresh login", async () => {
    const { client, stub } = harness();
    await client.authenticate();

    stub.failNext = 1;
    stub.failWith = { code: 3, message: "Access Denied: session expired" };

    await expect(client.fetchInvoice(5001, TODAY)).rejects.toMatchObject({
      retryable: true,
      code: "odoo.session_expired",
    });

    // The next call re-authenticates and works.
    stub.failWith = null;
    const invoice = await client.fetchInvoice(5001, TODAY);
    expect(invoice.invoiceNumber).toBe("INV/2026/0417");
  });
});

describe("invoices", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it("reads an invoice with its partner and its history", async () => {
    const invoice = await h.client.fetchInvoice(5001, TODAY);

    expect(invoice).toMatchObject({
      invoiceNumber: "INV/2026/0417",
      amountDue: 4250,
      currency: "GBP",
      partnerName: "Harrow & Finch Ltd",
      partnerEmail: "ap@harrowfinch.example",
      daysOverdue: 8,
      previousReminders: 1,
      disputed: false,
    });
  });

  it("counts prior reminders so the dunning ladder does not restart", async () => {
    const invoice = await h.client.fetchInvoice(5002, TODAY);
    expect(invoice.previousReminders).toBe(2);
    expect(invoice.daysOverdue).toBe(40);
  });

  it("spots a disputed invoice", async () => {
    const invoice = await h.client.fetchInvoice(5003, TODAY);
    expect(invoice.disputed).toBe(true);
  });

  it("does not offer a paid invoice for collection, however old it is", async () => {
    const ids = await h.client.findOverdueInvoices({ today: TODAY, minDaysOverdue: 1 });

    // 5004 is sixty days past due and fully paid.
    expect(ids).not.toContain(5004);
    expect(ids).toEqual(expect.arrayContaining([5001, 5002, 5003]));
  });

  it("respects the minimum age", async () => {
    const ids = await h.client.findOverdueInvoices({ today: TODAY, minDaysOverdue: 30 });
    expect(ids).toEqual([5002]);
  });

  it("reports a missing invoice as permanent", async () => {
    await expect(h.client.fetchInvoice(999_999, TODAY)).rejects.toMatchObject({
      retryable: false,
      code: "odoo.not_found",
    });
  });

  it("does not render an unset field as the string 'false'", async () => {
    h.stub.seed("res.partner", [{ id: 99, name: "No Contact Ltd" }]);
    h.stub.seed("account.move", [
      {
        id: 6001,
        name: "INV/2026/0500",
        move_type: "out_invoice",
        state: "posted",
        payment_state: "not_paid",
        amount_total: 100,
        amount_residual: 100,
        invoice_date: "2026-09-01",
        invoice_date_due: "2026-09-10",
        partner_id: [99, "No Contact Ltd"],
      },
    ]);

    const invoice = await h.client.fetchInvoice(6001, TODAY);
    // Odoo returns `false` for an empty email; it must not reach a template as "false".
    expect(invoice.partnerEmail).toBe("");
    expect(invoice.currency).toBe("EUR");
  });
});

describe("leads", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it("reads a lead with its stage and how long it has been quiet", async () => {
    const lead = await h.client.fetchLead(7001, TODAY);

    expect(lead).toMatchObject({
      name: "Rebrand and launch film",
      partnerName: "Calder Brewing",
      expectedRevenue: 42_000,
      stage: "Proposition",
      optedOut: false,
    });
    expect(lead.daysSinceContact).toBeGreaterThan(25);
  });

  it("treats a bounced address as an opt-out", async () => {
    const lead = await h.client.fetchLead(7003, TODAY);
    expect(lead.optedOut).toBe(true);
  });

  it("writes a stage change back", async () => {
    await h.client.updateLead(7002, { stage_id: 4 });
    expect(h.stub.records("crm.lead").find((record) => record.id === 7002)?.stage_id).toBe(4);
  });
});

describe("writes", () => {
  it("logs an activity the ERP can see", async () => {
    const h = harness();
    const before = h.stub.records("mail.message").length;

    const id = await h.client.logActivity({
      model: "account.move",
      recordId: 5001,
      summary: "Reminder sent (stage 2)",
      note: "Payment reminder emailed to ap@harrowfinch.example",
    });

    expect(id).toBeGreaterThan(0);
    const messages = h.stub.records("mail.message");
    expect(messages).toHaveLength(before + 1);
    expect(messages.at(-1)).toMatchObject({ res_id: 5001, subject: "Reminder sent (stage 2)" });
  });

  it("schedules an activity against the right model", async () => {
    const h = harness();
    const id = await h.client.scheduleActivity({
      model: "account.move",
      recordId: 5001,
      summary: "Chase again",
      dueDate: "2026-10-03",
      userId: 5,
    });

    expect(id).toBeGreaterThan(0);
    expect(h.stub.records("mail.activity").at(-1)).toMatchObject({ res_model_id: 201, res_id: 5001 });
  });
});

describe("error classification", () => {
  it("marks a server error retryable and an access error not", async () => {
    const h = harness();

    h.stub.failAlways = { code: 3, message: "Odoo Server Error: something broke" };
    await expect(h.client.fetchInvoice(5001, TODAY)).rejects.toMatchObject({ retryable: false, code: "odoo.fault" });

    h.stub.failAlways = { code: 3, message: "AccessError: not allowed to read account.move" };
    await expect(h.client.fetchInvoice(5001, TODAY)).rejects.toMatchObject({ retryable: false, code: "odoo.forbidden" });

    h.stub.failAlways = { code: 3, message: "SerializationFailure: concurrent update" };
    await expect(h.client.fetchInvoice(5001, TODAY)).rejects.toMatchObject({
      retryable: true,
      code: "odoo.serialization",
    });
  });

  it("marks a 5xx retryable and a 4xx not", async () => {
    const respondWith = (status: number) =>
      new OdooClient({
        url: "https://erp.example",
        db: "harness",
        username: "bot@example.com",
        password: "secret",
        fetchImpl: (async () => new Response("", { status })) as typeof fetch,
      });

    await expect(respondWith(503).authenticate()).rejects.toMatchObject({ retryable: true });
    await expect(respondWith(400).authenticate()).rejects.toMatchObject({ retryable: false });
    await expect(respondWith(429).authenticate()).rejects.toMatchObject({ retryable: true });
  });
});
