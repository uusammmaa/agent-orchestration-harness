/**
 * XML-RPC, just enough of it for Odoo.
 *
 * Odoo's external API is XML-RPC, and the available Node clients are either unmaintained,
 * pull in a DOM parser, or mishandle the two things that actually matter here: `nil` and
 * the `dateTime.iso8601` type. This is about two hundred lines and has no dependencies.
 *
 * The encoder is strict about what it will send. Odoo responds to a malformed request
 * with a fault that does not say which argument was wrong, so failing locally with a
 * clear message is worth more than being permissive.
 */

export type XmlRpcValue =
  | string
  | number
  | boolean
  | null
  | Date
  | XmlRpcValue[]
  | { [key: string]: XmlRpcValue };

export class XmlRpcFault extends Error {
  constructor(
    readonly faultCode: number,
    readonly faultString: string,
  ) {
    super(`Odoo fault ${faultCode}: ${faultString}`);
    this.name = "XmlRpcFault";
  }
}

export class XmlRpcTransportError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "XmlRpcTransportError";
  }
}

/* --------------------------------------------------------------------- encode ---- */

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

function encodeValue(value: XmlRpcValue): string {
  if (value === null || value === undefined) return "<value><nil/></value>";

  if (typeof value === "string") return `<value><string>${escapeXml(value)}</string></value>`;
  if (typeof value === "boolean") return `<value><boolean>${value ? 1 : 0}</boolean></value>`;

  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`XML-RPC cannot carry ${value}`);
    return Number.isInteger(value)
      ? `<value><int>${value}</int></value>`
      : `<value><double>${value}</double></value>`;
  }

  if (value instanceof Date) {
    // Odoo expects naive UTC with no separators and no zone marker.
    const iso = value.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "");
    return `<value><dateTime.iso8601>${iso}</dateTime.iso8601></value>`;
  }

  if (Array.isArray(value)) {
    return `<value><array><data>${value.map(encodeValue).join("")}</data></array></value>`;
  }

  const members = Object.entries(value)
    .filter(([, member]) => member !== undefined)
    .map(([name, member]) => `<member><name>${escapeXml(name)}</name>${encodeValue(member)}</member>`)
    .join("");
  return `<value><struct>${members}</struct></value>`;
}

export function encodeRequest(method: string, params: XmlRpcValue[]): string {
  const encoded = params.map((param) => `<param>${encodeValue(param)}</param>`).join("");
  return `<?xml version="1.0"?><methodCall><methodName>${escapeXml(method)}</methodName><params>${encoded}</params></methodCall>`;
}

/* --------------------------------------------------------------------- decode ---- */

/**
 * A small recursive-descent parser over the response text.
 *
 * A regex-based decoder falls over on nested structs, which Odoo returns constantly —
 * `search_read` on a relational field gives you arrays of structs several levels deep.
 */
class Parser {
  private pos = 0;

  constructor(private readonly xml: string) {}

  parseResponse(): { fault: boolean; value: XmlRpcValue } {
    const fault = this.xml.includes("<fault>");
    this.pos = this.xml.indexOf(fault ? "<fault>" : "<params>");
    if (this.pos === -1) throw new XmlRpcTransportError("Response is neither params nor a fault");

    this.seek("<value>");
    return { fault, value: this.parseValue() };
  }

  private seek(token: string): void {
    const index = this.xml.indexOf(token, this.pos);
    if (index === -1) throw new XmlRpcTransportError(`Expected ${token} in the response`);
    this.pos = index + token.length;
  }

  /** Name of the next opening tag, or null when the next thing is a closing tag. */
  private peekTag(): string | null {
    while (this.pos < this.xml.length && /\s/.test(this.xml[this.pos] ?? "")) this.pos++;
    if (this.xml[this.pos] !== "<") return null;
    if (this.xml[this.pos + 1] === "/") return null;

    const end = this.xml.indexOf(">", this.pos);
    if (end === -1) throw new XmlRpcTransportError("Unclosed tag in the response");
    return this.xml.slice(this.pos + 1, end).replace(/\/$/, "");
  }

  private readTextUntil(closing: string): string {
    const index = this.xml.indexOf(closing, this.pos);
    if (index === -1) throw new XmlRpcTransportError(`Expected ${closing}`);
    const text = this.xml.slice(this.pos, index);
    this.pos = index + closing.length;
    return text;
  }

  /** Assumes `pos` is just past a `<value>`. */
  private parseValue(): XmlRpcValue {
    const tag = this.peekTag();

    // <value>bare text</value> is legal and means string.
    if (tag === null) return unescapeXml(this.readTextUntil("</value>"));

    // `nil` is self-closing (`<nil/>`), so there is no `<nil>` to seek past. Every other
    // type has a matching pair.
    if (tag === "nil") {
      this.seekPast("</value>");
      return null;
    }

    this.seek(`<${tag}>`);

    switch (tag) {
      case "string":
        return unescapeXml(this.readTextUntil("</string>"));
      case "int":
      case "i4":
      case "i8":
        return Number.parseInt(this.readTextUntil(`</${tag}>`), 10);
      case "double":
        return Number.parseFloat(this.readTextUntil("</double>"));
      case "boolean":
        return this.readTextUntil("</boolean>").trim() === "1";
      case "dateTime.iso8601": {
        const raw = this.readTextUntil("</dateTime.iso8601>").trim();
        const match = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2}):(\d{2}):(\d{2})$/);
        // Odoo stores naive UTC, so that is how it is read back.
        return match
          ? new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`)
          : new Date(raw);
      }
      case "base64":
        return this.readTextUntil("</base64>").trim();
      case "array":
        return this.parseArray();
      case "struct":
        return this.parseStruct();
      default:
        throw new XmlRpcTransportError(`Unknown XML-RPC type <${tag}>`);
    }
  }

  private seekPast(token: string): void {
    const index = this.xml.indexOf(token, this.pos);
    if (index !== -1) this.pos = index + token.length;
  }

  private parseArray(): XmlRpcValue[] {
    this.seek("<data>");
    const items: XmlRpcValue[] = [];

    for (;;) {
      const next = this.xml.indexOf("<value>", this.pos);
      const close = this.xml.indexOf("</data>", this.pos);
      if (next === -1 || (close !== -1 && close < next)) break;

      this.pos = next + "<value>".length;
      items.push(this.parseValue());
      this.seekPast("</value>");
    }

    this.seekPast("</data>");
    this.seekPast("</array>");
    return items;
  }

  private parseStruct(): Record<string, XmlRpcValue> {
    const result: Record<string, XmlRpcValue> = {};

    for (;;) {
      const member = this.xml.indexOf("<member>", this.pos);
      const close = this.xml.indexOf("</struct>", this.pos);
      if (member === -1 || (close !== -1 && close < member)) break;

      this.pos = member + "<member>".length;
      this.seek("<name>");
      const name = unescapeXml(this.readTextUntil("</name>"));
      this.seek("<value>");
      result[name] = this.parseValue();
      this.seekPast("</value>");
      this.seekPast("</member>");
    }

    this.seekPast("</struct>");
    return result;
  }
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    // Ampersand last, or "&amp;lt;" decodes to "<" instead of "&lt;".
    .replace(/&amp;/g, "&");
}

export function decodeResponse(xml: string): XmlRpcValue {
  const { fault, value } = new Parser(xml).parseResponse();
  if (!fault) return value;

  const detail = value as { faultCode?: number; faultString?: string };
  throw new XmlRpcFault(detail.faultCode ?? -1, detail.faultString ?? "unknown Odoo fault");
}

/* ---------------------------------------------------------------------- call ---- */

export interface XmlRpcCallOptions {
  url: string;
  method: string;
  params: XmlRpcValue[];
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export async function xmlRpcCall(options: XmlRpcCallOptions): Promise<XmlRpcValue> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  // An Odoo instance under load will hold a connection open indefinitely; a worker
  // blocked on that holds its lease and looks alive while doing nothing.
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);

  try {
    const response = await fetchImpl(options.url, {
      method: "POST",
      headers: { "content-type": "text/xml" },
      body: encodeRequest(options.method, options.params),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new XmlRpcTransportError(`Odoo returned ${response.status}`, response.status);
    }
    return decodeResponse(await response.text());
  } catch (error) {
    if (error instanceof XmlRpcFault || error instanceof XmlRpcTransportError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new XmlRpcTransportError(`Odoo did not respond within ${options.timeoutMs ?? 20_000}ms`);
    }
    throw new XmlRpcTransportError(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
}
