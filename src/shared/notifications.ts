/**
 * The daily digest, as a pure decision.
 *
 * A family member who asks for it gets one plain-text email a day saying how
 * many photographs arrived since the last one they were told about, and a link
 * to the Recently added view. Nothing else: no thumbnails, no per-photo text,
 * nothing that could track a reader (design.md, "Notifications").
 *
 * Everything here is a pure function of the catalog, the stored state, and
 * Cloudflare's address list. Only the Worker's executor touches storage or the
 * send binding, so the rule that decides who gets told what can be tested
 * without a bucket, a domain, or an account.
 *
 * This module is compiled into all three targets, so it must stay free of DOM,
 * Node, and Workers globals.
 */

import { livePhotos } from './catalog.ts';
import type { Catalog } from './catalog.ts';

export const NOTIFICATION_SCHEMA_VERSION = 1;

export interface RecipientState {
  /** Whether the nightly digest goes to this address. */
  enabled: boolean;
  /**
   * The upload instant this address has been told about: the newest
   * `createdAt` covered by its last digest, or the instant it was enabled.
   * Photos with `createdAt` strictly greater are "new" to it.
   */
  seenThrough: string;
  /** The last digest actually sent, for the admin page. */
  lastSent: { at: string; count: number } | null;
}

export interface NotificationState {
  schemaVersion: number;
  /** Keyed by the lowercased address; see `normalizeEmail`. */
  recipients: Record<string, RecipientState>;
}

export function emptyNotificationState(): NotificationState {
  return { schemaVersion: NOTIFICATION_SCHEMA_VERSION, recipients: {} };
}

/**
 * One of Cloudflare's destination addresses, after the client boundary has
 * mapped it.
 *
 * Cloudflare's own `verified` is an ISO instant or `null`, and its `email` is
 * whatever was typed. Both are normalized in `cloudflare-addresses.ts`, so
 * nothing above here sees the raw shape.
 */
export interface DestinationAddress {
  id: string;
  email: string;
  verified: boolean;
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/**
 * One address, no whitespace, exactly one `@`, something either side.
 *
 * Deliberately not an attempt at RFC 5322: Cloudflare does its own checking
 * and its refusal is surfaced verbatim. This exists to keep a list, a header
 * injection, or an empty string from reaching the API or becoming a state key.
 */
export function isValidEmailAddress(value: string): boolean {
  if (value.length === 0 || value.length > 254) return false;
  if (/\s/.test(value)) return false;
  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@')) return false;
  const domain = value.slice(at + 1);
  return domain.length > 0 && domain.includes('.') && !domain.startsWith('.');
}

/**
 * The form an address takes everywhere below the boundary.
 *
 * Cloudflare returns what was typed, so `Aunt@Example.com` and
 * `aunt@example.com` are one recipient with two spellings. Lowercasing at
 * every boundary is what stops them becoming two state entries.
 */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// The digest rule
// ---------------------------------------------------------------------------

export interface DigestPlan {
  email: string;
  count: number;
  /**
   * The new watermark on success: the greatest `createdAt` in the set, not
   * `now`. A photo committed while the run is in flight has a later
   * `createdAt` than anything counted here, so it is covered tomorrow rather
   * than skipped forever.
   */
  seenThrough: string;
  /** Recorded as `lastSent.at` on success. The run's instant, for the page. */
  at: string;
}

/**
 * Who gets a digest tonight, and for how many photographs.
 *
 * An address must be **verified in Cloudflare and enabled in R2**. A missing
 * state entry is disabled: `GET /notifications` shows such an address as off,
 * and the cron agrees with what the page says.
 *
 * `createdAt` is an ISO instant, so a string comparison is the whole rule and
 * no `Date` is constructed. Only live photos count, so the number in the email
 * matches what the link will show.
 */
export function planDigests(
  catalog: Catalog,
  state: NotificationState,
  addresses: readonly DestinationAddress[],
  nowIso: string,
): DigestPlan[] {
  const live = livePhotos(catalog);
  const plans: DigestPlan[] = [];

  for (const address of addresses) {
    if (!address.verified) continue;
    const recipient = state.recipients[address.email];
    if (!recipient?.enabled) continue;

    const plan = digestFor(live, address.email, recipient.seenThrough, nowIso);
    if (plan.count > 0) plans.push(plan);
  }

  return plans.sort((a, b) => (a.email < b.email ? -1 : 1));
}

/**
 * The digest for one address, whether or not it is worth sending.
 *
 * Separate from `planDigests` because the test button computes exactly this
 * and then sends it regardless of the count — the point of the test is to show
 * the administrator what a recipient sees, including "nothing tonight".
 */
export function digestFor(
  live: readonly { createdAt: string }[],
  email: string,
  seenThrough: string,
  nowIso: string,
): DigestPlan {
  let count = 0;
  let newest = seenThrough;

  for (const photo of live) {
    if (photo.createdAt <= seenThrough) continue;
    count += 1;
    if (photo.createdAt > newest) newest = photo.createdAt;
  }

  return { email, count, seenThrough: newest, at: nowIso };
}

/**
 * The state after one digest was actually sent.
 *
 * Applied per successful send, never in a batch: a failed send for one address
 * must leave that address exactly as it was, so tomorrow's digest covers both
 * days, while every other recipient advances.
 */
export function recordDigestSent(
  state: NotificationState,
  plan: DigestPlan,
): NotificationState {
  const existing = state.recipients[plan.email];
  if (!existing) return state;

  return {
    ...state,
    recipients: {
      ...state.recipients,
      [plan.email]: {
        ...existing,
        seenThrough: plan.seenThrough,
        lastSent: { at: plan.at, count: plan.count },
      },
    },
  };
}

/**
 * Drop state entries for addresses Cloudflare no longer holds.
 *
 * Cloudflare's list is the recipient list (decisions.md, "Notifications"), so
 * an entry with no address behind it is invisible to both the page and the
 * cron already. This is the tidying, applied on the next write rather than on
 * every read.
 */
export function pruneNotificationState(
  state: NotificationState,
  addresses: readonly DestinationAddress[],
): NotificationState {
  const known = new Set(addresses.map((address) => address.email));
  const recipients: Record<string, RecipientState> = {};
  let dropped = false;

  for (const [email, recipient] of Object.entries(state.recipients)) {
    if (known.has(email)) recipients[email] = recipient;
    else dropped = true;
  }

  return dropped ? { ...state, recipients } : state;
}

// ---------------------------------------------------------------------------
// The message
// ---------------------------------------------------------------------------

function photos(count: number): string {
  return `${count} new photo${count === 1 ? '' : 's'}`;
}

export function digestSubject(count: number, siteTitle: string, test = false): string {
  const prefix = test ? '[Test] ' : '';
  const what = count === 0 ? 'No new photos' : photos(count);
  return `${prefix}${what} on ${siteTitle}`;
}

/**
 * The whole message. Plain text, no HTML part, no images.
 *
 * The link carries the display site's secret path segment — a capability the
 * recipient already holds, since it is how they see the photographs at all
 * (design.md, "Access and privacy model"). There is no unsubscribe link
 * because an unsubscribe endpoint would be a new unauthenticated write path;
 * the footer says what to do instead.
 */
export function digestBody(
  count: number,
  siteTitle: string,
  recentUrl: string,
): string {
  const opening =
    count === 0
      ? `No new photos have been added to ${siteTitle} since your last update.`
      : `${photos(count)} ${count === 1 ? 'was' : 'were'} added to ${siteTitle} ` +
        'since your last update.';

  return [
    opening,
    '',
    'See them here:',
    recentUrl,
    '',
    `This is a daily update from ${siteTitle}. To stop receiving it, ask`,
    'whoever runs the site.',
    '',
  ].join('\n');
}
