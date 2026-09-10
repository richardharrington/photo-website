import { describe, it, expect } from 'vitest';
import {
  NOTIFICATION_SCHEMA_VERSION,
  digestBody,
  digestFor,
  digestSubject,
  isValidEmailAddress,
  normalizeEmail,
  planDigests,
  pruneNotificationState,
  recordDigestSent,
} from '../../src/shared/notifications.ts';
import type {
  DestinationAddress,
  NotificationState,
} from '../../src/shared/notifications.ts';
import { makeCatalog, makePhoto, testPhotoId } from '../../fixtures/photos.ts';

const NOW = '2026-09-05T04:17:00.000Z';

function address(email: string, verified = true): DestinationAddress {
  return { id: `id-${email}`, email, verified };
}

function state(
  recipients: Record<string, Partial<NotificationState['recipients'][string]>>,
): NotificationState {
  return {
    schemaVersion: NOTIFICATION_SCHEMA_VERSION,
    recipients: Object.fromEntries(
      Object.entries(recipients).map(([email, partial]) => [
        email,
        {
          enabled: true,
          canSubmit: false,
          reviewsInbox: false,
          seenThrough: '2026-09-01T00:00:00.000Z',
          lastSent: null,
          ...partial,
        },
      ]),
    ),
  };
}

/** Photos are identified here only by when they were uploaded. */
function uploaded(createdAt: string, overrides: { trashedAt?: string } = {}) {
  return makePhoto({
    id: testPhotoId(createdAt),
    createdAt,
    trashedAt: overrides.trashedAt ?? null,
  });
}

describe('planDigests', () => {
  const catalog = makeCatalog([
    uploaded('2026-09-01T09:00:00.000Z'),
    uploaded('2026-09-03T09:00:00.000Z'),
    uploaded('2026-09-04T09:00:00.000Z'),
  ]);

  it('sends only to addresses that are verified and enabled', () => {
    const plans = planDigests(
      catalog,
      state({
        'on@example.com': { enabled: true },
        'off@example.com': { enabled: false },
        'unverified@example.com': { enabled: true },
      }),
      [
        address('on@example.com'),
        address('off@example.com'),
        address('unverified@example.com', false),
      ],
      NOW,
    );

    expect(plans.map((plan) => plan.email)).toEqual(['on@example.com']);
  });

  it('treats an address with no state entry as switched off', () => {
    // The write order in `add` is Cloudflare then R2, so a half-completed add
    // leaves exactly this. The page shows it as off, and the cron must agree.
    const plans = planDigests(catalog, state({}), [address('new@example.com')], NOW);
    expect(plans).toEqual([]);
  });

  it('counts only photos uploaded strictly after the watermark', () => {
    const plans = planDigests(
      catalog,
      state({ 'a@example.com': { seenThrough: '2026-09-01T09:00:00.000Z' } }),
      [address('a@example.com')],
      NOW,
    );

    expect(plans[0]?.count).toBe(2);
  });

  it('sends nothing when the set is empty, rather than a message saying zero', () => {
    const plans = planDigests(
      catalog,
      state({ 'a@example.com': { seenThrough: '2026-09-04T09:00:00.000Z' } }),
      [address('a@example.com')],
      NOW,
    );

    expect(plans).toEqual([]);
  });

  it('advances the watermark to the newest photo counted, never to now', () => {
    // "Now" would swallow a photo committed while the run was in flight: it
    // would fall under the new watermark without ever having been counted.
    const plans = planDigests(
      catalog,
      state({ 'a@example.com': { seenThrough: '2026-09-01T00:00:00.000Z' } }),
      [address('a@example.com')],
      NOW,
    );

    expect(plans[0]?.seenThrough).toBe('2026-09-04T09:00:00.000Z');
    expect(plans[0]?.seenThrough).not.toBe(NOW);
  });

  it('excludes trashed photos, so the count matches what the link will show', () => {
    const withTrash = makeCatalog([
      uploaded('2026-09-03T09:00:00.000Z'),
      uploaded('2026-09-04T09:00:00.000Z', { trashedAt: '2026-09-04T10:00:00.000Z' }),
    ]);

    const plans = planDigests(
      withTrash,
      state({ 'a@example.com': { seenThrough: '2026-09-02T00:00:00.000Z' } }),
      [address('a@example.com')],
      NOW,
    );

    expect(plans[0]?.count).toBe(1);
    // And the watermark stops at the live photo, not the trashed one.
    expect(plans[0]?.seenThrough).toBe('2026-09-03T09:00:00.000Z');
  });

  it('compares instants as strings, with no Date in the path', () => {
    // Millisecond precision on one side and not the other is exactly the case
    // a naive string comparison could get wrong; ISO instants sort correctly.
    const precise = makeCatalog([uploaded('2026-09-03T09:00:00.001Z')]);

    expect(
      planDigests(
        precise,
        state({ 'a@example.com': { seenThrough: '2026-09-03T09:00:00.000Z' } }),
        [address('a@example.com')],
        NOW,
      )[0]?.count,
    ).toBe(1);

    expect(
      planDigests(
        precise,
        state({ 'a@example.com': { seenThrough: '2026-09-03T09:00:00.002Z' } }),
        [address('a@example.com')],
        NOW,
      ),
    ).toEqual([]);
  });

  it('gives each recipient its own watermark', () => {
    const plans = planDigests(
      catalog,
      state({
        'behind@example.com': { seenThrough: '2026-08-01T00:00:00.000Z' },
        'current@example.com': { seenThrough: '2026-09-03T09:00:00.000Z' },
      }),
      [address('behind@example.com'), address('current@example.com')],
      NOW,
    );

    expect(plans.map((plan) => [plan.email, plan.count])).toEqual([
      ['behind@example.com', 3],
      ['current@example.com', 1],
    ]);
  });
});

describe('recordDigestSent', () => {
  it('advances only the address that was sent to', () => {
    const before = state({
      'a@example.com': { seenThrough: '2026-09-01T00:00:00.000Z' },
      'b@example.com': { seenThrough: '2026-09-01T00:00:00.000Z' },
    });

    const after = recordDigestSent(before, {
      email: 'a@example.com',
      count: 2,
      seenThrough: '2026-09-04T09:00:00.000Z',
      at: NOW,
      canSubmit: false,
      waiting: null,
    });

    expect(after.recipients['a@example.com']).toEqual({
      enabled: true,
      canSubmit: false,
      reviewsInbox: false,
      seenThrough: '2026-09-04T09:00:00.000Z',
      lastSent: { at: NOW, count: 2 },
    });
    expect(after.recipients['b@example.com']?.seenThrough).toBe(
      '2026-09-01T00:00:00.000Z',
    );
  });

  it('is a no-op for an address that has been removed meanwhile', () => {
    const before = state({});
    expect(
      recordDigestSent(before, {
        email: 'gone@example.com',
        count: 1,
        seenThrough: NOW,
        at: NOW,
        canSubmit: false,
        waiting: null,
      }),
    ).toBe(before);
  });
});

describe('pruneNotificationState', () => {
  it('drops entries for addresses Cloudflare no longer holds', () => {
    const pruned = pruneNotificationState(
      state({ 'kept@example.com': {}, 'gone@example.com': {} }),
      [address('kept@example.com')],
    );

    expect(Object.keys(pruned.recipients)).toEqual(['kept@example.com']);
  });

  it('returns the same object when there is nothing to drop, so no write happens', () => {
    const before = state({ 'kept@example.com': {} });
    expect(pruneNotificationState(before, [address('kept@example.com')])).toBe(before);
  });
});

describe('digestFor', () => {
  it('answers zero without pretending there is nothing to say', () => {
    // The test button sends this one; the nightly pass declines to.
    const plan = digestFor([], 'a@example.com', '2026-09-01T00:00:00.000Z', NOW);
    expect(plan).toEqual({
      canSubmit: false,
      waiting: null,
      email: 'a@example.com',
      count: 0,
      seenThrough: '2026-09-01T00:00:00.000Z',
      at: NOW,
    });
  });
});

describe('the message', () => {
  it('uses the singular for one photo and the plural for the rest', () => {
    expect(digestSubject(1, 'Family Photos')).toBe('1 new photo on Family Photos');
    expect(digestSubject(3, 'Family Photos')).toBe('3 new photos on Family Photos');
    expect(digestSubject(0, 'Family Photos')).toBe('No new photos on Family Photos');
  });

  it('marks a test subject as one', () => {
    expect(digestSubject(3, 'Family Photos', true)).toBe(
      '[Test] 3 new photos on Family Photos',
    );
    expect(digestSubject(0, 'Family Photos', true)).toBe(
      '[Test] No new photos on Family Photos',
    );
  });

  it('agrees its verb with the count and carries the link', () => {
    const one = digestBody(1, 'Family Photos', 'https://example.test/secret/recent');
    expect(one).toContain('1 new photo was added to Family Photos');
    expect(one).toContain('https://example.test/secret/recent');

    expect(
      digestBody(2, 'Family Photos', 'https://example.test/secret/recent'),
    ).toContain('2 new photos were added to Family Photos');
    expect(
      digestBody(0, 'Family Photos', 'https://example.test/secret/recent'),
    ).toContain('No new photos have been added to Family Photos');
  });

  it('says what to do instead of offering an unsubscribe link', () => {
    // An unsubscribe endpoint would be a new unauthenticated write path.
    const body = digestBody(1, 'Family Photos', 'https://example.test/secret/recent');
    expect(body).toContain('ask');
    expect(body).not.toMatch(/unsubscribe/i);
  });
});

describe('addresses', () => {
  it('accepts one plain address and refuses everything else', () => {
    expect(isValidEmailAddress('aunt@example.com')).toBe(true);
    expect(isValidEmailAddress('')).toBe(false);
    expect(isValidEmailAddress('nobody')).toBe(false);
    expect(isValidEmailAddress('@example.com')).toBe(false);
    expect(isValidEmailAddress('a@b')).toBe(false);
    expect(isValidEmailAddress('a@@example.com')).toBe(false);
    // A list, and a header injection, are both whitespace failures.
    expect(isValidEmailAddress('a@example.com, b@example.com')).toBe(false);
    expect(isValidEmailAddress('a@example.com\nBcc: c@example.com')).toBe(false);
  });

  it('lowercases, so one recipient cannot become two state entries', () => {
    expect(normalizeEmail('  Aunt@Example.COM ')).toBe('aunt@example.com');
  });
});

// ---------------------------------------------------------------------------
// The two submission additions
// ---------------------------------------------------------------------------

describe('planDigests and the inbox', () => {
  const catalog = makeCatalog([uploaded('2026-09-03T09:00:00.000Z')]);
  const quiet = makeCatalog([]);
  const waiting = { parts: 3, messages: 2 };

  it('marks a submitter’s plan, and leaves everyone else’s alone', () => {
    const plans = planDigests(
      catalog,
      state({
        'sender@example.com': { canSubmit: true },
        'reader@example.com': {},
      }),
      [address('sender@example.com'), address('reader@example.com')],
      NOW,
      waiting,
    );

    expect(plans.map((plan) => [plan.email, plan.canSubmit])).toEqual([
      ['reader@example.com', false],
      ['sender@example.com', true],
    ]);
  });

  it('carries the waiting count only to a reviewer', () => {
    const plans = planDigests(
      catalog,
      state({
        'reviewer@example.com': { reviewsInbox: true },
        'reader@example.com': {},
      }),
      [address('reviewer@example.com'), address('reader@example.com')],
      NOW,
      waiting,
    );

    const byEmail = Object.fromEntries(plans.map((plan) => [plan.email, plan.waiting]));
    expect(byEmail['reviewer@example.com']).toEqual(waiting);
    expect(byEmail['reader@example.com']).toBeNull();
  });

  /**
   * The one place the "only on a day something arrived" rule bends, and it
   * bends in the plan rather than in the executor so what is sent stays a pure
   * function of the three inputs.
   */
  it('sends to a reviewer on a quiet day when something is waiting', () => {
    const plans = planDigests(
      quiet,
      state({ 'reviewer@example.com': { reviewsInbox: true } }),
      [address('reviewer@example.com')],
      NOW,
      waiting,
    );

    expect(plans).toHaveLength(1);
    expect(plans[0]?.count).toBe(0);
    expect(plans[0]?.waiting).toEqual(waiting);
  });

  it('sends a reviewer nothing on a quiet day with an empty inbox', () => {
    expect(
      planDigests(
        quiet,
        state({ 'reviewer@example.com': { reviewsInbox: true } }),
        [address('reviewer@example.com')],
        NOW,
        { parts: 0, messages: 0 },
      ),
    ).toEqual([]);
  });

  it('sends a non-reviewer nothing on a quiet day, whatever is waiting', () => {
    expect(
      planDigests(
        quiet,
        state({ 'reader@example.com': {} }),
        [address('reader@example.com')],
        NOW,
        waiting,
      ),
    ).toEqual([]);
  });

  it('leaves the watermark exactly where it was for a waiting-only send', () => {
    const seenThrough = '2026-09-04T00:00:00.000Z';
    const plans = planDigests(
      quiet,
      state({ 'reviewer@example.com': { reviewsInbox: true, seenThrough } }),
      [address('reviewer@example.com')],
      NOW,
      waiting,
    );

    // Nothing was counted, so the new watermark is the old one.
    expect(plans[0]?.seenThrough).toBe(seenThrough);
  });

  it('defaults to an empty inbox when no argument is given', () => {
    const plans = planDigests(
      catalog,
      state({ 'reviewer@example.com': { reviewsInbox: true } }),
      [address('reviewer@example.com')],
      NOW,
    );
    expect(plans[0]?.waiting).toBeNull();
  });
});

describe('the digest message, with submissions', () => {
  const url = 'https://photos.test/secret/recent';

  it('is byte-for-byte unchanged for a recipient with neither bit', () => {
    expect(digestBody(2, 'Family Photos', url, {})).toBe(
      digestBody(2, 'Family Photos', url),
    );
  });

  it('adds the submission address only for a submitter', () => {
    const body = digestBody(2, 'Family Photos', url, {
      submitAddress: 'submit@example.test',
    });
    expect(body).toContain('email them to submit@example.test');
    expect(body).toContain('The subject');
    expect(body).toContain('line becomes the caption.');

    // The address travels only to people already allowed to send there.
    expect(digestBody(2, 'Family Photos', url, { submitAddress: null })).not.toContain(
      'submit@example.test',
    );
  });

  it('states what is waiting, after the opening', () => {
    const body = digestBody(2, 'Family Photos', url, {
      waiting: { parts: 3, messages: 2 },
    });
    expect(body).toContain(
      '3 emailed photos from 2 messages are waiting to be looked at.',
    );
    expect(body.indexOf('waiting to be looked at')).toBeLessThan(
      body.indexOf('See them here'),
    );
  });

  it('counts one photo and one message in the singular', () => {
    expect(
      digestBody(0, 'Family Photos', url, { waiting: { parts: 1, messages: 1 } }),
    ).toContain('1 emailed photo from 1 message is waiting to be looked at.');
  });

  it('says so in the subject when the waiting is the only news', () => {
    expect(digestSubject(0, 'Family Photos', false, true)).toBe(
      'Photos waiting for review on Family Photos',
    );
    // With new photos, the count is still the headline.
    expect(digestSubject(2, 'Family Photos', false, true)).toBe(
      '2 new photos on Family Photos',
    );
    // And with nothing waiting, nothing changed.
    expect(digestSubject(0, 'Family Photos', false, false)).toBe(
      'No new photos on Family Photos',
    );
  });
});
