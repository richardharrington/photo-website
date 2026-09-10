import { describe, it, expect } from 'vitest';
import {
  CLOUDFLARE_AUTHSERV_ID,
  authenticatesFor,
  domainOf,
  domainsAlign,
  parseAuthenticationResults,
} from '../../src/shared/email-auth.ts';

/**
 * The header Cloudflare Email Routing prepends to a message it delivers to a
 * Worker.
 *
 * **Written to the RFC 8601 grammar, not captured from a real message.** No
 * account with a domain existed when this was written, so what is pinned here
 * is the *shape* the standard defines — `authserv-id; method=result props;
 * method=result props`, with parenthesised comments anywhere — plus the
 * `authserv-id` this code expects Cloudflare to use, which is the one part
 * that is a genuine guess.
 *
 * The grammar is safe to rely on: every mail provider emits it, and the cases
 * below (folding, comments containing punctuation, several methods) are what
 * makes the parser worth having. The authserv-id is not, and if it is wrong
 * every submission drops silently — see `CLOUDFLARE_AUTHSERV_ID` and the
 * mismatch log that names what actually arrived.
 *
 * Replacing this with a real capture during account setup is a step in
 * operations.md, "Adding email submissions". The parser is a pure function of
 * the string, so that costs nothing but the paste.
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
      // Reported back so the Worker can log it. `CLOUDFLARE_AUTHSERV_ID` was
      // expected rather than measured, and if it is wrong every submission
      // drops silently — this is the one line that says what to change it to.
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
