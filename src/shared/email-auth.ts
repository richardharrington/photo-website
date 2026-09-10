/**
 * The second of the two proofs a submission must pass: that the message really
 * came from the mailbox its From header names.
 *
 * Cloudflare Email Routing adds an `Authentication-Results` header to every
 * message it delivers to a Worker, and that header is the only evidence
 * available inside one — the Worker sees a message that has already been
 * through SPF, DKIM and DMARC evaluation and cannot redo any of it.
 *
 * Three things make this safe to rely on, and each is a trap if forgotten:
 *
 *  - **Only the first header counts.** A sender can attach as many
 *    `Authentication-Results` headers as they like; Cloudflare prepends its
 *    own, so the topmost is the only one Cloudflare wrote. Scanning the whole
 *    block for any `dkim=pass` would accept a forgery outright.
 *  - **The authserv-id must be Cloudflare's.** A header whose identity is
 *    somebody else's is somebody else's claim.
 *  - **DKIM alone is not enough; it must align.** `dkim=pass` says the message
 *    was signed by *some* domain. DMARC's relaxed alignment (RFC 7489 §3.1.1)
 *    is what ties that signature to the From domain, so `header.d=` must equal
 *    the From domain or be a parent of it.
 *
 * A pure function of the header string, so a fixture captured from a real
 * delivered message is the whole test. Compiled into all three targets.
 */

/**
 * The authserv-id Cloudflare Email Routing stamps its own results with.
 *
 * **Confirmed against a real delivered message on 2026-09-10**: a Gmail
 * message routed through Cloudflare to this Worker authenticated, and the
 * comparison below is exact, so the identity matched. It was an expectation
 * before that — Cloudflare does not document the value — and it is checked
 * strictly either way, because a header written under somebody else's
 * identity is somebody else's claim.
 *
 * Should Cloudflare ever change it, the feature fails **closed and
 * silently**: every submission drops as `foreign-authserv` and no sender is
 * told anything. That is the right direction to be wrong in, but it is
 * indistinguishable from "nobody has emailed anything" without reading the
 * log — which is why a mismatch carries the identity it actually saw, and the
 * Worker logs it.
 */
export const CLOUDFLARE_AUTHSERV_ID = 'mx.cloudflare.net';

export type AuthFailureReason = 'no-header' | 'foreign-authserv' | 'no-aligned-pass';

export type AuthResult =
  | { ok: true; via: 'dmarc' | 'dkim' }
  | {
      ok: false;
      reason: AuthFailureReason;
      /**
       * The authserv-id actually present, when it was not the expected one.
       *
       * Carried so the Worker can log it: it is Cloudflare's own hostname,
       * never anything about the sender, and it is exactly the value an
       * operator needs to correct `CLOUDFLARE_AUTHSERV_ID` above.
       */
      sawAuthservId?: string;
    };

// ---------------------------------------------------------------------------
// Reading the raw header block
// ---------------------------------------------------------------------------

/**
 * The header block of a raw RFC 5322 message: everything before the first
 * blank line.
 *
 * Headers are read from the raw message rather than from the runtime's
 * `Headers` object, and that is not a preference. The Fetch `Headers` API
 * cannot return repeated headers separately — `get` joins them with a comma,
 * and `getAll` exists but throws for every name except `Set-Cookie`. Since
 * "only the **first** `Authentication-Results` counts" is the whole of the
 * anti-forgery rule here, a joined string is not good enough: a comma inside a
 * header value is legal, so the join cannot be reliably undone.
 */
export function headerBlockOf(text: string): string {
  const crlf = text.indexOf('\r\n\r\n');
  const lf = text.indexOf('\n\n');
  const end = crlf === -1 ? lf : lf === -1 ? crlf : Math.min(crlf, lf);
  return end === -1 ? text : text.slice(0, end);
}

/**
 * Every value of one header, in the order the message lists them.
 *
 * Continuation lines — the folding RFC 5322 allows on any long header — are
 * joined back onto the line they belong to before anything is read, so a
 * header wrapped across three lines is one value rather than three fragments.
 */
export function headerValues(block: string, name: string): string[] {
  const wanted = name.toLowerCase();
  const values: string[] = [];

  // Unfold first: a line beginning with a space or tab continues the one
  // before it, and the fold itself is not part of the value.
  const lines: string[] = [];
  for (const line of block.replace(/\r\n/g, '\n').split('\n')) {
    if (/^[ \t]/.test(line) && lines.length > 0) {
      lines[lines.length - 1] += ` ${line.trim()}`;
    } else {
      lines.push(line);
    }
  }

  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    if (line.slice(0, colon).trim().toLowerCase() !== wanted) continue;
    values.push(line.slice(colon + 1).trim());
  }

  return values;
}

/**
 * The bare address in the message's `From` header, lowercased, or null.
 *
 * The **header** From, not the envelope sender the runtime reports: DMARC
 * aligns a signature against `header.from`, and it is the header a reader
 * sees. They differ for a forward or a mailing list, and checking the wrong
 * one would authenticate the wrong domain.
 *
 * The display name is discarded here and never used for anything — it is
 * sender-controlled text, and the Inbox shows the address resolved from
 * Cloudflare's own list instead. Only the first `From` is read; a second is
 * not a thing a well-formed message has.
 */
export function fromHeaderAddress(block: string): string | null {
  const value = headerValues(block, 'from')[0];
  if (value === undefined) return null;

  // `Name <addr@example.com>` — the last angle-bracketed group wins, because a
  // display name may itself contain brackets.
  const angled = value.lastIndexOf('<');
  const bare =
    angled === -1
      ? value
      : value.slice(
          angled + 1,
          value.indexOf('>', angled) === -1 ? undefined : value.indexOf('>', angled),
        );

  const address = bare.trim().toLowerCase();
  return address.includes('@') && !/\s/.test(address) ? address : null;
}

/**
 * The domain part of an address, lowercased, or null.
 *
 * Takes a bare address; the display name has already been discarded by the
 * caller and must never reach here.
 */
export function domainOf(address: string): string | null {
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) return null;
  return address
    .slice(at + 1)
    .trim()
    .toLowerCase();
}

/**
 * DMARC relaxed alignment: the signing domain is the From domain, or an
 * organizational parent of it (`example.com` signing for
 * `mail.example.com`).
 *
 * Strict alignment would refuse the perfectly ordinary case of a provider
 * signing a subdomain's mail; the opposite direction is never accepted, so a
 * signature by `mail.example.com` does not authenticate `example.com`.
 */
export function domainsAlign(signing: string, from: string): boolean {
  if (signing === from) return true;
  return from.endsWith(`.${signing}`);
}

/**
 * Split an `Authentication-Results` value into its `method=result` clauses
 * with their properties.
 *
 * The grammar (RFC 8601) is `authserv-id; method=result (comment) prop=value
 * prop=value; method=result …`. Comments in parentheses may appear anywhere
 * and carry no meaning, so they are removed before anything is read.
 */
interface AuthMethod {
  method: string;
  result: string;
  properties: Record<string, string>;
}

interface ParsedAuthResults {
  authservId: string;
  methods: AuthMethod[];
}

function stripComments(value: string): string {
  let out = '';
  let depth = 0;
  for (const char of value) {
    if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) out += char;
  }
  return out;
}

export function parseAuthenticationResults(value: string): ParsedAuthResults {
  // Folded headers arrive with embedded newlines; they are whitespace here.
  const flat = stripComments(value).replace(/\s+/g, ' ').trim();
  const segments = flat.split(';');

  const authservId = (segments.shift() ?? '').trim().toLowerCase();
  const methods: AuthMethod[] = [];

  for (const segment of segments) {
    const tokens = segment
      .trim()
      .split(' ')
      .filter((token) => token !== '');
    const head = tokens.shift();
    if (!head) continue;

    const equals = head.indexOf('=');
    if (equals <= 0) continue;

    const properties: Record<string, string> = {};
    for (const token of tokens) {
      const split = token.indexOf('=');
      if (split <= 0) continue;
      properties[token.slice(0, split).toLowerCase()] = token
        .slice(split + 1)
        .replace(/^"|"$/g, '')
        .toLowerCase();
    }

    methods.push({
      method: head.slice(0, equals).toLowerCase(),
      result: head.slice(equals + 1).toLowerCase(),
      properties,
    });
  }

  return { authservId, methods };
}

/**
 * Whether this message authenticates for the domain its From header claims.
 *
 * `headers` is every `Authentication-Results` value in the message, **in
 * order**. Only the first is read; the rest exist in the argument precisely so
 * that a caller cannot accidentally pass the wrong one and so a test can prove
 * a forged second header does not rescue a failing first.
 *
 * `expectedAuthservId` defaults to Cloudflare's but is a parameter so a
 * captured fixture can be replayed without pretending about where it came
 * from.
 */
export function authenticatesFor(
  headers: readonly string[],
  fromAddress: string,
  expectedAuthservId: string = CLOUDFLARE_AUTHSERV_ID,
): AuthResult {
  const first = headers[0];
  if (first === undefined) return { ok: false, reason: 'no-header' };

  const parsed = parseAuthenticationResults(first);
  // The authserv-id may carry a trailing version token (`example.com 1;`).
  const identity = parsed.authservId.split(' ')[0] ?? '';
  if (identity !== expectedAuthservId.toLowerCase()) {
    return { ok: false, reason: 'foreign-authserv', sawAuthservId: identity };
  }

  const fromDomain = domainOf(fromAddress);
  if (fromDomain === null) return { ok: false, reason: 'no-aligned-pass' };

  for (const method of parsed.methods) {
    // DMARC already includes the alignment check, so a pass here needs no
    // further reasoning about which domain signed what.
    if (method.method === 'dmarc' && method.result === 'pass') {
      return { ok: true, via: 'dmarc' };
    }
  }

  for (const method of parsed.methods) {
    if (method.method !== 'dkim' || method.result !== 'pass') continue;
    const signing = method.properties['header.d'];
    if (signing && domainsAlign(signing, fromDomain)) {
      return { ok: true, via: 'dkim' };
    }
  }

  return { ok: false, reason: 'no-aligned-pass' };
}
