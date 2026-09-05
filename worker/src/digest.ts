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
import type { DestinationAddress, DigestPlan } from '../../src/shared/notifications.ts';
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

async function send(
  deps: DigestDeps,
  to: string,
  count: number,
  test: boolean,
): Promise<void> {
  await deps.email.send({
    from: { name: deps.siteTitle, email: deps.from },
    to,
    subject: digestSubject(count, deps.siteTitle, test),
    text: digestBody(count, deps.siteTitle, recentUrl(deps.displaySiteUrl)),
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

  const plans = planDigests(catalog, state, addresses, nowIso);
  report.skippedEmpty =
    report.considered -
    report.skippedUnverified -
    report.skippedDisabled -
    plans.length;

  for (const plan of plans) {
    try {
      await send(deps, plan.email, plan.count, false);
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
  const plan = digestFor(livePhotos(catalog), email, seenThrough, nowIso);

  await send(deps, email, plan.count, true);
  return { count: plan.count };
}
