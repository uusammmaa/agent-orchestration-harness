# Odoo integration

## Connecting

Odoo's external API is XML-RPC over two endpoints: `/xmlrpc/2/common` to authenticate and
`/xmlrpc/2/object` for everything else.

```bash
ODOO_URL=https://your-company.odoo.com
ODOO_DB=your-database
ODOO_USERNAME=automation@your-company.com
ODOO_API_KEY=...
```

Use an **API key**, not a password: *Settings → Users → your automation user → Account
Security → New API Key*. A password stops working when somebody changes it, and it grants
everything that user can do in the UI as well.

Give the automation user the narrowest role that works — read on `account.move`,
`res.partner` and `crm.lead`, write on `mail.message` and `mail.activity`. It does not
need to post invoices or register payments, and a bot that cannot do those things cannot
do them by accident.

## Why the XML-RPC client is in this repo

The available Node clients are unmaintained, pull in a DOM parser, or mishandle the two
things that matter here: `nil` and `dateTime.iso8601`. The one in `packages/odoo` is about
two hundred lines with no dependencies, and its own first test run caught a `<nil/>`
parsing bug — self-closing tags need handling that a `<tag>…</tag>` parser does not give
you for free.

Two details worth knowing if you extend it:

- **Odoo returns `false` for an empty field**, not null and not an empty string. Code that
  does not expect that renders "false" to a customer. `asString` and `asNumber` in
  `client.ts` exist for exactly this.
- **A many2one arrives as `[id, display_name]`**, or `false` when unset. `relationId` and
  `relationName` handle both.

## Error classification

This is the part that matters operationally, because it decides whether a failure is
retried.

**Retryable:**

| | Why |
|---|---|
| `Access Denied` / `session expired` | The cached uid went stale. The client clears it and the next call logs in again |
| `SerializationFailure` / `concurrent update` | Odoo serialises some writes and asks you to try again |
| HTTP 5xx, 429, or a network error | The usual |

**Not retryable:**

| | Why |
|---|---|
| `AccessError` / `not allowed` | A permission problem. Forty seconds of retrying will not grant it |
| `MissingError` / `does not exist` | The record is not going to appear |
| HTTP 4xx other than 429 | The request is wrong and will be wrong next time |

Odoo puts everything in `faultString`, so the classification reads the string. That is
unpleasant and unavoidable — there is no structured error code.

## Idempotency

Every handler can be run twice, because a worker can die after doing the work and before
reporting it. Odoo has no idempotency key on `mail.message`, so `odoo.log_activity` looks
for an existing note with the same subject on the same record before writing one.

That is a read plus a write rather than an atomic upsert, and it is a genuine race. It is
the right trade anyway: losing the race duplicates a note occasionally, and not checking
duplicates a note on **every** retry.

## The stub

`packages/odoo/src/stub.ts` is an Odoo that speaks real XML-RPC over an injectable
`fetch`. The client's encoder, decoder, session caching and error classification are all
exercised against it for real — a hand-mocked client would skip exactly the layer most
likely to be wrong.

It fails on demand, which is how the retry and quarantine paths get covered without
waiting for a real Odoo to have a bad day:

```ts
stub.failNext = 1;
stub.failWith = { code: 3, message: "Access Denied: session expired" };
// the run recovers on the retry, and the failure is on the record
```

`seedStub` loads a small realistic company: four partners, four invoices at different
ages and payment states — including one that is **paid and sixty days past due**, which
must never be picked up for collection — plus a disputed one, and three leads including
one whose address has bounced.

The harness falls back to the stub when `ODOO_*` is unset, and says so at `/health`.

## Extending it

Add a method, not a generic escape hatch. A typed surface is the difference between a
compile error and a `False` arriving where a record was expected.

```ts
async fetchPayment(paymentId: number): Promise<OdooPayment> {
  const [record] = await this.searchRead<PaymentRow>(
    "account.payment",
    [["id", "=", paymentId]],
    ["name", "amount", "payment_type", "partner_id"],
    { limit: 1 },
  );
  if (!record) throw new OdooError(`No payment ${paymentId}`, false, "odoo.not_found");
  return { id: paymentId, amount: asNumber(record.amount), /* … */ };
}
```

Then seed the stub with the model and write the test. If the field can be empty in Odoo,
the test should include a record where it is.

## Version compatibility

Written against Odoo 16 and 17. The field names used are stable across both:

| Model | Fields |
|---|---|
| `account.move` | `name`, `amount_total`, `amount_residual`, `invoice_date`, `invoice_date_due`, `state`, `payment_state`, `partner_id` |
| `res.partner` | `name`, `email`, `phone`, `credit_limit`, `total_invoiced`, `trust` |
| `crm.lead` | `name`, `partner_name`, `email_from`, `expected_revenue`, `probability`, `stage_id`, `date_last_stage_update`, `message_bounce` |

`payment_state` is 16+. On 15 it is `invoice_payment_state` with different values, so
`findOverdueInvoices` needs adjusting.
