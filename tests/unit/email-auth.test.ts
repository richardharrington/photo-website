import { describe, it, expect } from 'vitest';
import {
  CLOUDFLARE_AUTHSERV_ID,
  authenticatesFor,
  domainOf,
  domainsAlign,
  fromHeaderAddress,
  headerBlockOf,
  headerValues,
  parseAuthenticationResults,
} from '../../src/shared/email-auth.ts';

/**
 * The header Cloudflare Email Routing prepends to a message it delivers to a
 * Worker.
 *
 * **Written to the RFC 8601 grammar, not captured verbatim.** What is pinned
 * here is the shape the standard defines — `authserv-id; method=result props;
 * method=result props`, with parenthesised comments anywhere — which every
 * mail provider emits, and which the cases below (folding, comments
 * containing punctuation, several methods) are what make the parser worth
 * having.
 *
 * The `authserv-id` in it is no longer a guess: a real Gmail message routed
 * through Cloudflare authenticated on 2026-09-10, and the comparison is
 * exact, so `CLOUDFLARE_AUTHSERV_ID` is right. Replacing the rest of this
 * string with a verbatim capture is still worth doing if a real one is ever
 * to hand — the parser is a pure function of it, so that costs nothing but
 * the paste — but nothing now depends on it.
 */
const CLOUDFLARE_GMAIL = `${CLOUDFLARE_AUTHSERV_ID}; dkim=pass header.d=gmail.com header.i=@gmail.com header.b="abc123"; spf=pass (${CLOUDFLARE_AUTHSERV_ID}: domain of aunt@gmail.com designates 209.85.128.0 as permitted sender) smtp.mailfrom=aunt@gmail.com; dmarc=pass (p=NONE sp=QUARANTINE dis=NONE) header.from=gmail.com`;

describe('parseAuthenticationResults', () => {
  it('reads the authserv-id and every method clause', () => {
    const parsed = parseAuthenticationResults(CLOUDFLARE_GMAIL);

    expect(parsed.authservId).toBe(CLOUDFLARE_AUTHSERV_ID);
    expect(parsed.methods.map((method) => [method.method, method.result])).toEqual([
      ['dkim', 'pass'],
      ['spf', 'pass'],
      ['dmarc', 'pass'],
    ]);
    expect(parsed.methods[0]?.properties['header.d']).toBe('gmail.com');
  });

  it('ignores parenthesised comments, wherever they sit', () => {
    // The SPF clause above carries one containing a semicolon-free sentence
    // with `domain of …` in it, which must not become a property.
    const spf = parseAuthenticationResults(CLOUDFLARE_GMAIL).methods[1];
    expect(spf?.properties['smtp.mailfrom']).toBe('aunt@gmail.com');
    expect(spf?.properties['domain']).toBeUndefined();
  });

  it('survives a folded header, which is how a long one arrives', () => {
    const folded = `${CLOUDFLARE_AUTHSERV_ID};\r\n\tdkim=pass\r\n header.d=icloud.com;\r\n dmarc=pass header.from=icloud.com`;
    const parsed = parseAuthenticationResults(folded);
    expect(parsed.authservId).toBe(CLOUDFLARE_AUTHSERV_ID);
    expect(parsed.methods[0]?.properties['header.d']).toBe('icloud.com');
  });
});

describe('domainOf', () => {
  it('takes what follows the last @, lowercased', () => {
    expect(domainOf('Aunt@Example.COM')).toBe('example.com');
    expect(domainOf('a@b@example.com')).toBe('example.com');
  });

  it('is null for anything that is not an address', () => {
    expect(domainOf('nobody')).toBeNull();
    expect(domainOf('@example.com')).toBeNull();
    expect(domainOf('aunt@')).toBeNull();
  });
});

describe('domainsAlign', () => {
  it('accepts an exact match and a parent domain', () => {
    expect(domainsAlign('example.com', 'example.com')).toBe(true);
    // DMARC relaxed alignment: a provider signing a subdomain's mail.
    expect(domainsAlign('example.com', 'mail.example.com')).toBe(true);
  });

  it('never accepts the other direction, or a lookalike suffix', () => {
    expect(domainsAlign('mail.example.com', 'example.com')).toBe(false);
    expect(domainsAlign('example.com', 'notexample.com')).toBe(false);
    expect(domainsAlign('example.com', 'example.com.evil.test')).toBe(false);
  });
});

describe('authenticatesFor', () => {
  it('accepts the Cloudflare fixture, on DMARC', () => {
    expect(authenticatesFor([CLOUDFLARE_GMAIL], 'aunt@gmail.com')).toEqual({
      ok: true,
      via: 'dmarc',
    });
  });

  it('accepts an aligned dkim=pass with no DMARC clause', () => {
    const header = `${CLOUDFLARE_AUTHSERV_ID}; dkim=pass header.d=example.com; spf=fail`;
    expect(authenticatesFor([header], 'aunt@mail.example.com')).toEqual({
      ok: true,
      via: 'dkim',
    });
  });

  it('refuses dkim=pass for an unaligned domain', () => {
    // Signed by somebody — which is exactly what an unaligned pass proves, and
    // exactly why it is not enough.
    const header = `${CLOUDFLARE_AUTHSERV_ID}; dkim=pass header.d=bulk-sender.test`;
    expect(authenticatesFor([header], 'aunt@example.com')).toEqual({
      ok: false,
      reason: 'no-aligned-pass',
    });
  });

  it('refuses a dkim=pass with no header.d at all', () => {
    const header = `${CLOUDFLARE_AUTHSERV_ID}; dkim=pass`;
    expect(authenticatesFor([header], 'aunt@example.com').ok).toBe(false);
  });

  it('refuses a failing first header even when a later one passes', () => {
    // The sender attached the second. Only the first is Cloudflare's, and
    // scanning the block for any dkim=pass would accept a forgery outright.
    const forged = `${CLOUDFLARE_AUTHSERV_ID}; dkim=pass header.d=example.com; dmarc=pass`;
    const real = `${CLOUDFLARE_AUTHSERV_ID}; dkim=fail header.d=example.com; dmarc=fail`;

    expect(authenticatesFor([real, forged], 'aunt@example.com')).toEqual({
      ok: false,
      reason: 'no-aligned-pass',
    });
  });

  it('refuses a header written under somebody else’s authserv-id', () => {
    const header = 'mx.somewhere-else.test; dmarc=pass header.from=example.com';
    expect(authenticatesFor([header], 'aunt@example.com')).toEqual({
      ok: false,
      reason: 'foreign-authserv',
      // Reported back so the Worker can log it. Should Cloudflare ever change
      // the identity it stamps, every submission would drop silently — this is
      // the one line that says what to change the constant to.
      sawAuthservId: 'mx.somewhere-else.test',
    });
  });

  it('refuses a message with no Authentication-Results at all', () => {
    expect(authenticatesFor([], 'aunt@example.com')).toEqual({
      ok: false,
      reason: 'no-header',
    });
  });

  it('refuses a From that is not an address', () => {
    expect(authenticatesFor([CLOUDFLARE_GMAIL], 'nobody').ok).toBe(false);
  });

  it('refuses dmarc=fail and dmarc=none', () => {
    for (const result of ['fail', 'none', 'temperror', 'permerror']) {
      const header = `${CLOUDFLARE_AUTHSERV_ID}; dmarc=${result} header.from=example.com`;
      expect(authenticatesFor([header], 'aunt@example.com').ok).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Reading the raw header block
// ---------------------------------------------------------------------------

/**
 * These exist because the runtime's `Headers` object cannot do this job, and
 * finding that out cost a silently broken deploy.
 *
 * `get('authentication-results')` joins repeated headers with a comma, which
 * cannot be reliably undone because a comma inside a value is legal.
 * `getAll` is present on Cloudflare's Headers — so a `typeof ... ===
 * 'function'` guard passes — and then throws for every name except
 * `Set-Cookie`. Since "only the first counts" is the whole anti-forgery rule,
 * the raw block is the only honest source.
 */
describe('headerBlockOf', () => {
  it('stops at the first blank line, CRLF or LF', () => {
    expect(headerBlockOf('A: 1\r\nB: 2\r\n\r\nbody\r\nA: not a header')).toBe(
      'A: 1\r\nB: 2',
    );
    expect(headerBlockOf('A: 1\nB: 2\n\nbody')).toBe('A: 1\nB: 2');
  });

  it('takes a headers-only message whole', () => {
    expect(headerBlockOf('A: 1\r\nB: 2')).toBe('A: 1\r\nB: 2');
  });

  /**
   * A body line that looks like a header must never be read as one — it is
   * sender-controlled, and this is the anti-forgery boundary.
   */
  it('never reads a header out of the body', () => {
    const raw = [
      `Authentication-Results: ${CLOUDFLARE_AUTHSERV_ID}; dmarc=fail`,
      '',
      `Authentication-Results: ${CLOUDFLARE_AUTHSERV_ID}; dmarc=pass`,
    ].join('\r\n');

    expect(headerValues(headerBlockOf(raw), 'authentication-results')).toEqual([
      `${CLOUDFLARE_AUTHSERV_ID}; dmarc=fail`,
    ]);
  });
});

describe('headerValues', () => {
  it('returns repeated headers separately, in message order', () => {
    const block = [
      'Authentication-Results: first',
      'From: a@example.com',
      'Authentication-Results: second',
    ].join('\r\n');

    expect(headerValues(block, 'authentication-results')).toEqual(['first', 'second']);
  });

  it('unfolds a header wrapped across lines', () => {
    const block = [
      `Authentication-Results: ${CLOUDFLARE_AUTHSERV_ID};`,
      '\tdkim=pass header.d=icloud.com;',
      ' dmarc=pass header.from=icloud.com',
      'From: a@icloud.com',
    ].join('\r\n');

    const [value] = headerValues(block, 'authentication-results');
    expect(headerValues(block, 'authentication-results')).toHaveLength(1);
    expect(value).toContain('dkim=pass header.d=icloud.com');
    expect(authenticatesFor([value!], 'a@icloud.com')).toEqual({
      ok: true,
      via: 'dmarc',
    });
  });

  it('keeps a comma inside a value intact', () => {
    // The reason a comma-joined Headers.get() cannot be undone.
    const block = 'Authentication-Results: x; dmarc=pass (p=NONE, sp=NONE)';
    expect(headerValues(block, 'authentication-results')).toEqual([
      'x; dmarc=pass (p=NONE, sp=NONE)',
    ]);
  });

  it('matches the name case-insensitively and finds nothing when absent', () => {
    expect(headerValues('AUTHENTICATION-RESULTS: x', 'authentication-results')).toEqual(
      ['x'],
    );
    expect(headerValues('From: a@example.com', 'authentication-results')).toEqual([]);
  });
});

describe('fromHeaderAddress', () => {
  it('takes the bare address and discards the display name', () => {
    expect(fromHeaderAddress('From: Aunt Mary <Aunt@Example.COM>')).toBe(
      'aunt@example.com',
    );
    expect(fromHeaderAddress('From: aunt@example.com')).toBe('aunt@example.com');
  });

  it('survives a display name containing angle brackets', () => {
    expect(fromHeaderAddress('From: "Mary <the aunt>" <aunt@example.com>')).toBe(
      'aunt@example.com',
    );
  });

  it('reads the header From, not some other address in the block', () => {
    const block = [
      'Sender: list@bulk.test',
      'From: Aunt Mary <aunt@example.com>',
      'Reply-To: someone-else@elsewhere.test',
    ].join('\r\n');
    // Reply-To and Sender are ignored; DMARC aligns against header.from.
    expect(fromHeaderAddress(block)).toBe('aunt@example.com');
  });

  it('is null when there is no usable From', () => {
    expect(fromHeaderAddress('To: someone@example.com')).toBeNull();
    expect(fromHeaderAddress('From: not-an-address')).toBeNull();
    expect(fromHeaderAddress('From:')).toBeNull();
  });
});
