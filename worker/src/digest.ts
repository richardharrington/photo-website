/**
 * The nightly digest pass, and the test send behind the admin page's button.
 *
 * Only this file sends. The rule that decides who is told what is a pure
 * function in `src/shared/notifications.ts`; everything here is the executor
 * around it — read the addresses, read the catalog, send, record.
 *
 * Sends happen one address at a time and are never batched onto one message:
 * a family member should not learn who else is on the list.
 */

import { loadCatalog } from '../../src/shared/catalog-repository.ts';
import { cloudflareAddresses } from '../../src/shared/cloudflare-addresses.ts';
import type { FetchLike } from '../../src/shared/cloudflare-addresses.ts';
import { livePhotos } from '../../src/shared/catalog.ts';
import {
  digestBody,
  digestFor,
  digestSubject,
  planDigests,
  pruneNotificationState,
  recordDigestSent,
} from '../../src/shared/notifications.ts';
import type {
  DestinationAddress,
  DigestPlan,
  InboxWaiting,
} from '../../src/shared/notifications.ts';
import { inboxUsage } from '../../src/shared/inbox-repository.ts';
import {
  loadNotificationState,
  mutateNotificationState,
} from '../../src/shared/notifications-repository.ts';
import type { ObjectStore } from '../../src/shared/store.ts';

/**
 * The send binding, declared structurally.
 *
 * `@cloudflare/workers-types` declares the real `SendEmail` as an ambient
 * global, which exists under `tsconfig.worker.json` and nowhere else — and the
 * Worker's unit tests compile under the browser tsconfig. This mirrors why
 * `R2Like` exists: one structural shape that typechecks everywhere and that a
 * test can satisfy with an object literal.
 */
export interface SendEmailLike {
  send(message: {
    from: { name: string; email: string };
    to: string;
    subject: string;
    text: string;
  }): Promise<unknown>;
}

/**
 * Everything the pass needs from the environment, already checked.
 *
 * Assembled by `digestConfig`, which is where a missing secret is caught. The
 * pass itself never reads `env`, so it cannot half-run on half a deployment.
 */
export interface DigestDeps {
  store: ObjectStore;
  email: SendEmailLike;
  fetch: FetchLike;
  accountId: string;
  apiToken: string;
  /** The bare `photos@<domain>`; the site title supplies the display name. */
  from: string;
  siteTitle: string;
  /** The display site's base URL, including its secret path, no trailing `/`. */
  displaySiteUrl: string;
  /**
   * The submission address, when this deployment accepts mail.
   *
   * It reaches only the digests of recipients who may actually use it, so the
   * address travels to nobody who is not already allowed to send there.
   */
  submitAddress?: string | null;
  now: () => Date;
}

export interface DigestReport {
  /** Every destination address in the account. */
  considered: number;
  sent: number;
  skippedUnverified: number;
  skippedDisabled: number;
  skippedEmpty: number;
  failed: number;
}

function recentUrl(displaySiteUrl: string): string {
  return `${displaySiteUrl.replace(/\/+$/, '')}/recent`;
}

/**
 * One message, from a plan.
 *
 * Everything the plan carries decides what is in it: the count, whether a
 * reviewer has something waiting, and whether this recipient may submit. A
 * recipient with neither of the two new bits receives a message byte for byte
 * identical to the one this feature found.
 */
async function send(deps: DigestDeps, plan: DigestPlan, test: boolean): Promise<void> {
  await deps.email.send({
    from: { name: deps.siteTitle, email: deps.from },
    to: plan.email,
    subject: digestSubject(plan.count, deps.siteTitle, test, plan.waiting !== null),
    text: digestBody(plan.count, deps.siteTitle, recentUrl(deps.displaySiteUrl), {
      waiting: plan.waiting,
      submitAddress: plan.canSubmit ? (deps.submitAddress ?? null) : null,
    }),
  });
}

/**
 * Record one successful send.
 *
 * Written after the send, never before: a watermark advanced ahead of a
 * message that never left would silently skip a day's photographs. The other
 * order is only a duplicate digest, which is the cheaper mistake.
 *
 * The prune rides along here because this is a mutation of the state file, and
 * an entry whose address Cloudflare no longer holds is already invisible to
 * both the page and this pass.
 */
async function recordSend(
  deps: DigestDeps,
  addresses: readonly DestinationAddress[],
  plan: DigestPlan,
): Promise<void> {
  await mutateNotificationState(deps.store, (state) => ({
    state: recordDigestSent(pruneNotificationState(state, addresses), plan),
    value: undefined,
  }));
}

/**
 * Tonight's pass.
 *
 * A failed send for one address leaves that address's entry untouched and the
 * loop carries on: tomorrow's digest for it covers both days, and nobody else
 * is affected. There is no global watermark to corrupt.
 */
export async function runDigest(deps: DigestDeps): Promise<DigestReport> {
  const client = cloudflareAddresses(deps.fetch, deps.accountId, deps.apiToken);
  const addresses = await client.list();

  const nowIso = deps.now().toISOString();
  const { catalog } = await loadCatalog(deps.store, () => nowIso);
  const { state } = await loadNotificationState(deps.store);
  // One list of the inbox prefix for the whole run: what is waiting is the
  // same fact for every reviewer.
  const waiting = await waitingInInbox(deps);

  const report: DigestReport = {
    considered: addresses.length,
    sent: 0,
    skippedUnverified: 0,
    skippedDisabled: 0,
    skippedEmpty: 0,
    failed: 0,
  };

  // Counted from the same three inputs `planDigests` reasons about, so the log
  // line adds up to `considered` whatever the plan turns out to be.
  for (const address of addresses) {
    if (!address.verified) report.skippedUnverified += 1;
    else if (!state.recipients[address.email]?.enabled) report.skippedDisabled += 1;
  }

  const plans = planDigests(catalog, state, addresses, nowIso, waiting);
  report.skippedEmpty =
    report.considered -
    report.skippedUnverified -
    report.skippedDisabled -
    plans.length;

  for (const plan of plans) {
    try {
      await send(deps, plan, false);
      await recordSend(deps, addresses, plan);
      report.sent += 1;
    } catch (error) {
      report.failed += 1;

      console.error('Digest send failed', JSON.stringify({ email: plan.email }), error);
    }
  }

  return report;
}

/**
 * The admin page's "Send test": tonight's digest for one address, computed
 * now, marked as a test, and **not** written back.
 *
 * It sends even when the count is zero — the point is to show the
 * administrator exactly what a recipient sees, including a quiet night. It
 * requires the address to be verified in Cloudflare, because Cloudflare would
 * refuse otherwise and the failure would be opaque; it does not consult
 * `enabled`, because testing before enabling is the whole use.
 *
 * Returns null when the address is not a verified destination, which the
 * caller turns into the same 404 as every other refusal.
 */
export async function runDigestTest(
  deps: DigestDeps,
  email: string,
): Promise<{ count: number } | null> {
  const client = cloudflareAddresses(deps.fetch, deps.accountId, deps.apiToken);
  const addresses = await client.list();

  const address = addresses.find((candidate) => candidate.email === email);
  if (!address?.verified) return null;

  const nowIso = deps.now().toISOString();
  const { catalog } = await loadCatalog(deps.store, () => nowIso);
  const { state } = await loadNotificationState(deps.store);

  // An address with no entry has never been told anything, and enabling it
  // would start its clock at that moment — so "now" is the honest watermark to
  // preview against. Counting the whole library instead would show a number no
  // real digest could ever produce.
  const seenThrough = state.recipients[email]?.seenThrough ?? nowIso;
  const recipient = state.recipients[email];

  // Whatever the recipient would get tonight, both additions included, so the
  // administrator can see them. `reviewsInbox` gates the waiting line here
  // exactly as it does in the real pass.
  const inbox = await waitingInInbox(deps);
  const plan = digestFor(livePhotos(catalog), email, seenThrough, nowIso, {
    canSubmit: recipient?.canSubmit ?? false,
    waiting: recipient?.reviewsInbox && inbox.parts > 0 ? inbox : null,
  });

  await send(deps, plan, true);
  return { count: plan.count };
}

/**
 * What the Inbox is holding, for the reviewers' line.
 *
 * Fails soft. The waiting line is an addition to the digest, not the digest:
 * a failed listing must cost a reviewer that one sentence, never tonight's
 * message about the photographs that actually arrived.
 */
async function waitingInInbox(deps: DigestDeps): Promise<InboxWaiting> {
  try {
    const usage = await inboxUsage(deps.store);
    return { parts: usage.parts, messages: usage.messages };
  } catch (error) {
    console.error('The inbox could not be counted for the digest', error);
    return { parts: 0, messages: 0 };
  }
}
