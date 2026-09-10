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
 * **Unverified against a real delivered message.** No account with a domain
 * existed when this was written and Cloudflare does not document the value, so
 * this is the expected one rather than a measured one. It is still checked
 * strictly, because a header written under somebody else's identity is
 * somebody else's claim.
 *
 * If it is wrong the feature fails **closed and silently**: every submission
 * drops as `foreign-authserv` and no sender is told anything. That is the
 * right direction to be wrong in, but it is indistinguishable from "nobody has
 * emailed anything" without reading the log — which is why a mismatch carries
 * the identity it actually saw, and the Worker logs it. Confirming this
 * against the first real message is a step in operations.md, "Adding email
 * submissions".
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
