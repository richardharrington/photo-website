import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import worker from '../../worker/src/index.ts';
import type { Env } from '../../worker/src/index.ts';
import { handleSubmission } from '../../worker/src/email.ts';
import type { EmailMessageLike, SubmissionDeps } from '../../worker/src/email.ts';
import type { SendEmailLike } from '../../worker/src/digest.ts';
import { InMemoryObjectStore } from '../../fixtures/in-memory-store.ts';
import { bindingFor } from '../../fixtures/r2-binding.ts';
import {
  INBOX_MAX_PARTS,
  R2_KEYS,
  submissionPartKey,
  submissionRecordKey,
} from '../../src/shared/constants.ts';
import { encodeJson } from '../../src/shared/store.ts';
import { CLOUDFLARE_AUTHSERV_ID } from '../../src/shared/email-auth.ts';
import { NOTIFICATION_SCHEMA_VERSION } from '../../src/shared/notifications.ts';
import type { NotificationState } from '../../src/shared/notifications.ts';
import { listSubmissions } from '../../src/shared/inbox-repository.ts';
import type { FetchLike } from '../../src/shared/cloudflare-addresses.ts';

const NOW = new Date('2026-09-08T14:02:00.000Z');
const SUBMIT = 'submit@example.test';
const SENDER = 'aunt@example.test';

const PASSING_AUTH = `${CLOUDFLARE_AUTHSERV_ID}; dkim=pass header.d=example.test; dmarc=pass header.from=example.test`;

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function fakeEmail() {
  const sent: { to: string; subject: string; text: string }[] = [];
  const binding: SendEmailLike = {
    async send(message) {
      sent.push({ to: message.to, subject: message.subject, text: message.text });
      return {};
    },
  };
  return { binding, sent };
}

/** Cloudflare's address API, faked at the HTTP boundary as the digest tests do. */
function fakeFetch(addresses: readonly { email: string; verified: boolean }[]) {
  const fetchImpl: FetchLike = async (url) => {
    const page = Number(new URL(url).searchParams.get('page') ?? '1');
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          success: true,
          result:
            page > 1
              ? []
              : addresses.map((address, index) => ({
                  id: `cf-${index}`,
                  email: address.email,
                  verified: address.verified ? '2026-08-01T00:00:00.000Z' : null,
                })),
        };
      },
    };
  };
  return fetchImpl;
}

function stateWith(overrides: Partial<{ canSubmit: boolean }> = {}): NotificationState {
  return {
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    recipients: {
      [SENDER]: {
        enabled: false,
        canSubmit: overrides.canSubmit ?? true,
        reviewsInbox: false,
        seenThrough: '2026-09-01T00:00:00.000Z',
        lastSent: null,
      },
    },
  };
}

/**
 * A raw RFC 822 message with the given parts.
 *
 * Built by hand rather than by a library so what `postal-mime` is handed is
 * exactly what a mail client sends, base64 and all — and so a part can be
 * given a deliberately wrong `Content-Type`, which is the case that matters
 * most here.
 */
function rawMessage(options: {
  subject?: string | null;
  text?: string | null;
  parts?: { filename: string; contentType: string; bytes: Uint8Array }[];
}): string {
  const boundary = 'boundary-abc';
  const lines = [
    `From: Aunt Mary <${SENDER}>`,
    `To: ${SUBMIT}`,
    ...(options.subject === undefined || options.subject === null
      ? []
      : [`Subject: ${options.subject}`]),
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    options.text ?? '',
  ];

  for (const part of options.parts ?? []) {
    lines.push(
      `--${boundary}`,
      `Content-Type: ${part.contentType}`,
      `Content-Disposition: attachment; filename="${part.filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      base64(part.bytes),
    );
  }

  lines.push(`--${boundary}--`, '');
  return lines.join('\r\n');
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function jpeg(size = 4096): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  bytes[3] = 0xe0;
  return bytes;
}

function pdf(size = 512): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(new TextEncoder().encode('%PDF-1.7'));
  return bytes;
}

interface FakeMessage extends EmailMessageLike {
  rejections: string[];
}

function message(options: {
  to?: string;
  from?: string;
  auth?: readonly string[];
  raw?: string;
}): FakeMessage {
  const raw = options.raw ?? rawMessage({ subject: 'Beach day', parts: [] });
  const authHeaders = options.auth ?? [PASSING_AUTH];
  const rejections: string[] = [];

  return {
    from: options.from ?? SENDER,
    to: options.to ?? SUBMIT,
    headers: {
      get: (name) =>
        name.toLowerCase() === 'authentication-results'
          ? (authHeaders[0] ?? null)
          : null,
      getAll: (name) =>
        name.toLowerCase() === 'authentication-results' ? [...authHeaders] : [],
    },
    raw: new Blob([raw]).stream(),
    rawSize: raw.length,
    setReject: (reason) => rejections.push(reason),
    rejections,
  };
}

function seedStore(state = stateWith()): InMemoryObjectStore {
  const store = new InMemoryObjectStore({ now: () => NOW });
  store.seed(R2_KEYS.notifications, encodeJson(state));
  return store;
}

function deps(
  store: InMemoryObjectStore,
  email: SendEmailLike,
  addresses: readonly { email: string; verified: boolean }[] = [
    { email: SENDER, verified: true },
  ],
): SubmissionDeps {
  return {
    store,
    email,
    fetch: fakeFetch(addresses),
    accountId: 'account',
    apiToken: 'token',
    from: 'photos@example.test',
    siteTitle: 'Family Photos',
    submitAddress: SUBMIT,
    now: () => NOW,
  };
}

// Every path logs; the tests are about outcomes, not console noise.
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

describe('handleSubmission, accepted', () => {
  const raw = rawMessage({
    subject: 'Fwd: Beach day',
    text: 'Here they are\n',
    parts: [
      // Labelled application/octet-stream, as mail clients routinely do. Only
      // the bytes are believed.
      {
        filename: 'IMG_4021.JPG',
        contentType: 'application/octet-stream',
        bytes: jpeg(),
      },
      { filename: 'notes.pdf', contentType: 'application/pdf', bytes: pdf() },
    ],
  });

  it('stores the sniffed image parts and skips everything else', async () => {
    const store = seedStore();
    const { binding } = fakeEmail();

    const outcome = await handleSubmission(deps(store, binding), message({ raw }));

    expect(outcome).toEqual({
      status: 'accepted',
      submissionId: expect.stringMatching(/^[0-9a-f]{32}$/),
      parts: 1,
    });

    const [stored] = await listSubmissions(store);
    expect(stored?.parts).toEqual([
      { index: 0, filename: 'IMG_4021.JPG', contentType: 'image/jpeg', bytes: 4096 },
    ]);
    expect(store.has(submissionPartKey(stored!.id, 0))).toBe(true);
  });

  it('records the sender as an address id, never as an address', async () => {
    const store = seedStore();
    const { binding } = fakeEmail();

    await handleSubmission(deps(store, binding), message({ raw }));

    const [stored] = await listSubmissions(store);
    expect(stored?.submittedBy).toBe('cf-0');
    expect(JSON.stringify(stored)).not.toContain(SENDER);
  });

  it('keeps the raw subject and the caption it proposes', async () => {
    const store = seedStore();
    const { binding } = fakeEmail();

    await handleSubmission(deps(store, binding), message({ raw }));

    const [stored] = await listSubmissions(store);
    expect(stored?.subject).toBe('Fwd: Beach day');
    expect(stored?.proposedCaption).toBe('Beach day');
    expect(stored?.bodyLine).toBe('Here they are');
    expect(stored?.claim).toBeNull();
    expect(stored?.receivedAt).toBe(NOW.toISOString());
  });

  it('writes the record after the parts', async () => {
    const store = seedStore();
    const { binding } = fakeEmail();

    await handleSubmission(deps(store, binding), message({ raw }));
    const [stored] = await listSubmissions(store);

    const writes = store.calls.filter(
      (call) =>
        call.includes(submissionPartKey(stored!.id, 0)) ||
        call.includes(submissionRecordKey(stored!.id)),
    );
    expect(writes[0]).toBe(`put ${submissionPartKey(stored!.id, 0)}`);
    expect(writes[1]).toBe(`putConditional ${submissionRecordKey(stored!.id)}`);
  });

  it('sends the receipt last, after everything is stored', async () => {
    const store = seedStore();
    const { binding, sent } = fakeEmail();
    let storedWhenSent: string[] = [];
    const watching: SendEmailLike = {
      async send(msg) {
        storedWhenSent = store.keys();
        return binding.send(msg);
      },
    };

    await handleSubmission(deps(store, watching), message({ raw }));

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(SENDER);
    expect(sent[0]?.subject).toBe('Got your photos for Family Photos');
    expect(sent[0]?.text).toContain('1 photo from your message "Fwd: Beach day"');
    expect(sent[0]?.text).toContain('JPEG, PNG or HEIC');
    // No link back to the site: the sender already holds one, and a receipt is
    // not a place to put a capability.
    expect(sent[0]?.text).not.toContain('http');
    expect(storedWhenSent.some((key) => key.endsWith('message.json'))).toBe(true);
  });

  it('keeps the submission when the receipt cannot be sent', async () => {
    const store = seedStore();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failing: SendEmailLike = {
      async send() {
        throw new Error('Cloudflare refused');
      },
    };

    const outcome = await handleSubmission(deps(store, failing), message({ raw }));

    expect(outcome.status).toBe('accepted');
    expect(await listSubmissions(store)).toHaveLength(1);
  });

  it('audits the arrival without the address or the subject', async () => {
    const store = seedStore();
    const { binding } = fakeEmail();

    await handleSubmission(deps(store, binding), message({ raw }));

    const events = store
      .keys()
      .filter((key) => key.startsWith(R2_KEYS.auditPrefix))
      .map((key) =>
        store.readJson<{ action: string; via: string; note?: string }>(key)!,
      );

    const received = events.find((event) => event.action === 'submission-received');
    expect(received?.via).toBe('email');
    expect(received?.note).toContain('1 parts');
    expect(received?.note).toContain('from address cf-0');
    expect(received?.note).not.toContain(SENDER);
    expect(received?.note).not.toContain('Beach day');
  });
});

// ---------------------------------------------------------------------------
// Every row of the refusal table
// ---------------------------------------------------------------------------

describe('handleSubmission, refused', () => {
  const withPhoto = rawMessage({
    subject: 'Beach day',
    parts: [{ filename: 'a.jpg', contentType: 'image/jpeg', bytes: jpeg() }],
  });

  /** Nothing stored, nothing sent, and no bounce: the message is simply gone. */
  async function expectSilentDrop(
    store: InMemoryObjectStore,
    msg: FakeMessage,
    addresses?: readonly { email: string; verified: boolean }[],
  ) {
    const { binding, sent } = fakeEmail();
    const outcome = await handleSubmission(deps(store, binding, addresses), msg);

    expect(outcome.status).toBe('dropped');
    expect(msg.rejections).toEqual([]);
    expect(sent).toEqual([]);
    expect(await listSubmissions(store)).toEqual([]);
    return outcome;
  }

  it('drops a message addressed anywhere but the submission address', async () => {
    // A catch-all routing rule must never be able to feed this handler.
    const outcome = await expectSilentDrop(
      seedStore(),
      message({ to: 'photos@example.test', raw: withPhoto }),
    );
    expect(outcome).toEqual({ status: 'dropped', reason: 'wrong-recipient' });
  });

  it('drops a sender Cloudflare does not hold', async () => {
    const outcome = await expectSilentDrop(seedStore(), message({ raw: withPhoto }), [
      { email: 'somebody-else@example.test', verified: true },
    ]);
    expect(outcome).toEqual({ status: 'dropped', reason: 'unknown-sender' });
  });

  it('drops a sender who has not clicked the confirmation link', async () => {
    const outcome = await expectSilentDrop(seedStore(), message({ raw: withPhoto }), [
      { email: SENDER, verified: false },
    ]);
    expect(outcome).toEqual({ status: 'dropped', reason: 'unverified-sender' });
  });

  it('drops a verified sender who is not switched on for submissions', async () => {
    const outcome = await expectSilentDrop(
      seedStore(stateWith({ canSubmit: false })),
      message({ raw: withPhoto }),
    );
    expect(outcome).toEqual({ status: 'dropped', reason: 'not-a-submitter' });
  });

  it('drops a sender with no state entry at all', async () => {
    const store = new InMemoryObjectStore({ now: () => NOW });
    const outcome = await expectSilentDrop(store, message({ raw: withPhoto }));
    expect(outcome).toEqual({ status: 'dropped', reason: 'not-a-submitter' });
  });

  it('drops a message that does not authenticate', async () => {
    const outcome = await expectSilentDrop(
      seedStore(),
      message({
        raw: withPhoto,
        auth: [`${CLOUDFLARE_AUTHSERV_ID}; dkim=fail; dmarc=fail`],
      }),
    );
    expect(outcome).toEqual({ status: 'dropped', reason: 'not-authenticated' });
  });

  it('drops a message with no Authentication-Results at all', async () => {
    await expectSilentDrop(seedStore(), message({ raw: withPhoto, auth: [] }));
  });

  it('is not rescued by a forged second Authentication-Results header', async () => {
    await expectSilentDrop(
      seedStore(),
      message({
        raw: withPhoto,
        auth: [
          `${CLOUDFLARE_AUTHSERV_ID}; dmarc=fail`,
          `${CLOUDFLARE_AUTHSERV_ID}; dmarc=pass`,
        ],
      }),
    );
  });

  it('bounces an allowed sender whose message holds no usable image', async () => {
    const store = seedStore();
    const { binding, sent } = fakeEmail();
    const msg = message({
      raw: rawMessage({
        subject: 'A document',
        // Named .jpg, and not one. Only the bytes are believed.
        parts: [{ filename: 'holiday.jpg', contentType: 'image/jpeg', bytes: pdf() }],
      }),
    });

    const outcome = await handleSubmission(deps(store, binding), msg);

    expect(outcome).toEqual({ status: 'bounced', reason: 'no-photos' });
    expect(msg.rejections[0]).toContain('No photos were found');
    expect(await listSubmissions(store)).toEqual([]);
    // The bounce is the message; no receipt goes with it.
    expect(sent).toEqual([]);
  });

  it('bounces when the inbox is already over its cap', async () => {
    const store = seedStore();
    for (let i = 0; i < INBOX_MAX_PARTS; i += 1) {
      store.seed(`${R2_KEYS.inboxPrefix}full/parts/${i}`, new Uint8Array(1));
    }
    const { binding, sent } = fakeEmail();
    const msg = message({ raw: withPhoto });

    const outcome = await handleSubmission(deps(store, binding), msg);

    expect(outcome).toEqual({ status: 'bounced', reason: 'inbox-full' });
    expect(msg.rejections[0]).toContain('not accepting photos just now');
    expect(sent).toEqual([]);
  });

  it('accepts the usable parts of a mixed message without a bounce', async () => {
    const store = seedStore();
    const { binding } = fakeEmail();
    const msg = message({
      raw: rawMessage({
        subject: 'Beach day',
        parts: [
          { filename: 'a.jpg', contentType: 'image/jpeg', bytes: jpeg() },
          { filename: 'notes.pdf', contentType: 'application/pdf', bytes: pdf() },
          { filename: 'b.jpg', contentType: 'image/jpeg', bytes: jpeg() },
        ],
      }),
    });

    const outcome = await handleSubmission(deps(store, binding), msg);

    expect(outcome).toEqual({
      status: 'accepted',
      submissionId: expect.any(String),
      parts: 2,
    });
    expect(msg.rejections).toEqual([]);
  });

  it('never names the sender or the subject in a log line', async () => {
    const log = vi.mocked(console.log);
    await expectSilentDrop(
      seedStore(stateWith({ canSubmit: false })),
      message({ raw: withPhoto }),
    );

    const lines = log.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(lines).toContain('example.test');
    expect(lines).not.toContain(SENDER);
    expect(lines).not.toContain('Beach day');
  });
});

// ---------------------------------------------------------------------------
// The Worker's own handler
// ---------------------------------------------------------------------------

describe('worker.email', () => {
  function envFor(store: InMemoryObjectStore, email: SendEmailLike): Env {
    return {
      PHOTOS: bindingFor(store),
      ASSET_SIGNING_KEY: 'key',
      EMAIL: email,
      FETCH: fakeFetch([{ email: SENDER, verified: true }]),
      SITE_TITLE: 'Family Photos',
      NOTIFY_FROM: 'photos@example.test',
      DISPLAY_SITE_URL: 'https://photos.test/secret',
      CLOUDFLARE_ACCOUNT_ID: 'account',
      CLOUDFLARE_ADDRESSES_READ_TOKEN: 'token',
      SUBMIT_ADDRESS: SUBMIT,
    };
  }

  const raw = rawMessage({
    subject: 'Beach day',
    parts: [{ filename: 'a.jpg', contentType: 'image/jpeg', bytes: jpeg() }],
  });

  it('accepts a message end to end', async () => {
    const store = seedStore();
    const { binding, sent } = fakeEmail();

    await worker.email(message({ raw }), envFor(store, binding));

    expect(await listSubmissions(store)).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  /** Unconfigured means inert, exactly as the digest is. */
  it('accepts nothing when SUBMIT_ADDRESS is unset', async () => {
    const store = seedStore();
    const { binding, sent } = fakeEmail();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const msg = message({ raw });

    await worker.email(msg, { ...envFor(store, binding), SUBMIT_ADDRESS: undefined });

    expect(await listSubmissions(store)).toEqual([]);
    expect(sent).toEqual([]);
    // Silence, not a bounce: an unconfigured deployment must not tell a sender
    // that something is there.
    expect(msg.rejections).toEqual([]);
  });

  it('accepts nothing when the send binding is missing', async () => {
    const store = seedStore();
    const { binding } = fakeEmail();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await worker.email(message({ raw }), {
      ...envFor(store, binding),
      EMAIL: undefined,
    });

    expect(await listSubmissions(store)).toEqual([]);
  });

  /**
   * A thrown error would be a delivery failure and therefore a bounce, which
   * would tell an unknown sender that their message reached something.
   */
  it('swallows a fault rather than turning it into a bounce', async () => {
    const store = seedStore();
    const { binding } = fakeEmail();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(store, 'list').mockRejectedValue(new Error('R2 is having a day'));
    const msg = message({ raw });

    await expect(worker.email(msg, envFor(store, binding))).resolves.toBeUndefined();
    expect(msg.rejections).toEqual([]);
  });
});
