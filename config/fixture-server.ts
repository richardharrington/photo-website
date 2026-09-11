/**
 * Local development fake: the display API, the admin API, and the asset
 * Worker, all in-process.
 *
 * No Netlify or Cloudflare account is required to run and exercise either app.
 * It runs the *real* projection and mutation functions over an in-memory
 * object store, so what is exercised locally is the real contract and the real
 * conditional-write logic — only the storage and the image bytes are fake.
 *
 * Development only. It is mounted by the Vite dev server and is never part of
 * a production build.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { fixtureCatalog } from '../fixtures/catalog.ts';
import { InMemoryObjectStore } from '../fixtures/in-memory-store.ts';
import {
  photoResponse,
  timelineResponse,
  toPublicPhoto,
} from '../src/shared/display-api.ts';
import { getLivePhoto, livePhotos, trashedPhotos } from '../src/shared/catalog.ts';
import type { Catalog } from '../src/shared/catalog.ts';
import { loadCatalog, mutateCatalog } from '../src/shared/catalog-repository.ts';
import {
  applyCaptions,
  beginBatch,
  commitPhoto,
  editPhotoMetadata,
  permanentlyDeletePhotos,
  resolveSelection,
  resolveTrashedSelection,
  restorePhotos,
  trashPhotos,
} from '../src/shared/admin-operations.ts';
import type { SelectionQuery } from '../src/shared/admin-operations.ts';
import {
  INBOX_CLAIM_TTL_MINUTES,
  R2_KEYS,
  RENDITION_SPECS,
  SIGNED_URL_TTL_SECONDS,
  submissionPartKey,
} from '../src/shared/constants.ts';
import type { Rendition } from '../src/shared/constants.ts';
import { encodeJson } from '../src/shared/store.ts';
import {
  digestFor,
  isValidEmailAddress,
  newRecipient,
  normalizeEmail,
} from '../src/shared/notifications.ts';
import type {
  DestinationAddress,
  NotificationState,
  RecipientState,
} from '../src/shared/notifications.ts';
import {
  loadNotificationState,
  mutateNotificationState,
} from '../src/shared/notifications-repository.ts';
import { generateAuditId, generatePhotoId } from '../src/shared/ids.ts';
import {
  claimSubmission,
  isValidSubmissionId,
  listSubmissions,
  loadSubmission,
  removeSubmission,
} from '../src/shared/inbox-repository.ts';
import { storeSubmission } from '../src/shared/inbox-repository.ts';
import {
  SUBMISSION_SCHEMA_VERSION,
  firstBodyLine,
  isClaimLive,
  proposeCaption,
  selectImageParts,
} from '../src/shared/submissions.ts';
import type { Submission } from '../src/shared/submissions.ts';
import { downloadFilenameFor } from '../src/shared/filename.ts';
import { baseSecurityHeaders } from '../src/shared/headers.ts';

const store = new InMemoryObjectStore();
store.seed(R2_KEYS.catalog, encodeJson(fixtureCatalog()));

const now = () => new Date().toISOString();
const context = { now };

/** Uploaded artifact bytes, so a committed photo can be served back. */
const uploadedObjects = new Map<string, Uint8Array>();

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    ...baseSecurityHeaders(),
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function sendNotFound(res: ServerResponse): void {
  res.writeHead(404, {
    ...baseSecurityHeaders(),
    'content-type': 'text/plain; charset=utf-8',
  });
  res.end('Not Found');
}

function sendBadRequest(res: ServerResponse, error: string): void {
  sendJson(res, 400, { error });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

async function currentCatalog(): Promise<Catalog> {
  return (await loadCatalog(store, now)).catalog;
}

/**
 * A placeholder image standing in for a real derivative.
 *
 * SVG rather than a generated WebP: the point is to exercise layout, lazy
 * loading, and the trash's signed-thumbnail path, and encoding real bytes here
 * would add a codec dependency to the dev server for no benefit. The label
 * makes it obvious which rendition the browser actually requested.
 */
function placeholderSvg(width: number, height: number, label: string, hue: number) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="hsl(${hue} 45% 72%)"/>
  <text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle"
        font-family="system-ui, sans-serif" font-size="${Math.round(Math.min(width, height) / 8)}"
        fill="hsl(${hue} 60% 22%)">${label}</text>
</svg>`;
}

function hueFor(photoId: string): number {
  let hash = 0;
  for (let i = 0; i < photoId.length; i += 1) {
    hash = (hash * 31 + photoId.charCodeAt(i)) % 360;
  }
  return hash;
}

function isRendition(value: string): value is Rendition {
  return Object.prototype.hasOwnProperty.call(RENDITION_SPECS, value);
}

// ---------------------------------------------------------------------------
// Asset Worker stand-in
// ---------------------------------------------------------------------------

async function serveAsset(
  res: ServerResponse,
  photoId: string,
  rendition: string,
  signed: boolean,
): Promise<boolean> {
  const catalog = await currentCatalog();
  if (!isRendition(rendition)) {
    sendNotFound(res);
    return true;
  }

  // The capability route refuses trashed photos and the full-resolution
  // original, exactly as the real Worker must; the signed route may serve a
  // trashed thumbnail, which the trash view needs.
  const photo = signed ? catalog.photos[photoId] : getLivePhoto(catalog, photoId);
  if (!photo || (!signed && rendition === 'full')) {
    sendNotFound(res);
    return true;
  }
  if (signed && photo.trashedAt !== null && rendition === 'full') {
    sendNotFound(res);
    return true;
  }

  const stored = uploadedObjects.get(`${photoId}/${rendition}`);
  if (stored) {
    res.writeHead(200, {
      ...baseSecurityHeaders(),
      'content-type': RENDITION_SPECS[rendition].contentType,
    });
    res.end(Buffer.from(stored));
    return true;
  }

  const descriptor = photo.derivatives[rendition];
  res.writeHead(200, {
    ...baseSecurityHeaders(),
    'content-type': 'image/svg+xml',
    'cache-control': signed
      ? 'private, no-store'
      : 'public, max-age=31536000, immutable',
  });
  res.end(
    placeholderSvg(descriptor.width, descriptor.height, rendition, hueFor(photoId)),
  );
  return true;
}

// ---------------------------------------------------------------------------
// Display API
// ---------------------------------------------------------------------------

async function handleDisplay(route: string, res: ServerResponse): Promise<boolean> {
  const catalog = await currentCatalog();

  if (route === '/timeline') {
    sendJson(
      res,
      200,
      timelineResponse(catalog, process.env.SITE_TITLE ?? 'Family Photos', Date.now()),
    );
    return true;
  }
  const photo = /^\/photo\/([0-9a-f]{32})$/.exec(route);
  if (photo) {
    const body = photoResponse(catalog, photo[1]!);
    if (body) sendJson(res, 200, body);
    else sendNotFound(res);
    return true;
  }

  const download = /^\/download\/([0-9a-f]{32})$/.exec(route);
  if (download) {
    const record = getLivePhoto(catalog, download[1]!);
    if (!record) {
      sendNotFound(res);
      return true;
    }
    sendJson(res, 200, {
      // Production returns an HMAC-signed Worker URL; locally the signed route
      // is unsigned, so the button is still exercisable.
      url: `/d/${record.id}/full`,
      expiresAt: new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString(),
      filename: record.downloadFilename,
    });
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Cloudflare destination addresses, faked, and the Emails page's routes
// ---------------------------------------------------------------------------

/**
 * The account's destination-address list, in memory.
 *
 * In production this is Cloudflare's, reached over its API, and *it* decides
 * whether an address is verified — there is no local copy. Here it is a Map,
 * and the verification step is faked by a naming convention: an address whose
 * local part begins with `pending` never verifies, everything else verifies the
 * moment it is added. Both states have to be reachable from a test, and one
 * that had to click a link in a real mailbox would not be a test.
 */
const fakeAddresses = new Map<string, DestinationAddress>();
let fakeAddressSeq = 0;

/** What the local /notify/test "sent", for anyone tailing the dev server. */
const sentTestDigests: { email: string; count: number; at: string }[] = [];

function addFakeAddress(email: string): DestinationAddress {
  fakeAddressSeq += 1;
  const address: DestinationAddress = {
    id: `dev-address-${fakeAddressSeq}`,
    email,
    verified: !email.startsWith('pending'),
  };
  fakeAddresses.set(email, address);
  return address;
}

function listFakeAddresses(): DestinationAddress[] {
  return [...fakeAddresses.values()].sort((a, b) => (a.email < b.email ? -1 : 1));
}

async function notificationState(): Promise<NotificationState> {
  return (await loadNotificationState(store)).state;
}

function recipientRow(address: DestinationAddress, state: NotificationState) {
  const recipient = state.recipients[address.email];
  return {
    id: address.id,
    email: address.email,
    verified: address.verified,
    enabled: recipient?.enabled ?? false,
    canSubmit: recipient?.canSubmit ?? false,
    reviewsInbox: recipient?.reviewsInbox ?? false,
    lastSent: recipient?.lastSent ?? null,
  };
}

/**
 * The local stand-in for `POST /notify/test` on the asset Worker.
 *
 * Production signs a sixty-second grant and posts it across; here the admin
 * handler calls this directly. It computes exactly what the real one computes
 * and sends nothing.
 */
async function fakeNotifyTest(email: string): Promise<{ count: number } | null> {
  const address = fakeAddresses.get(email);
  if (!address?.verified) return null;

  const at = now();
  const state = await notificationState();
  const seenThrough = state.recipients[email]?.seenThrough ?? at;
  const plan = digestFor(livePhotos(await currentCatalog()), email, seenThrough, at);

  sentTestDigests.push({ email, count: plan.count, at });
  console.log('[fixture] would send test digest', JSON.stringify(plan));
  return { count: plan.count };
}

async function handleEmails(
  route: string,
  method: string,
  body: Body,
  res: ServerResponse,
): Promise<boolean> {
  if (method === 'GET' && route === '/emails') {
    const state = await notificationState();
    sendJson(res, 200, {
      recipients: listFakeAddresses().map((address) => recipientRow(address, state)),
    });
    return true;
  }

  if (method !== 'POST') return false;

  if (route === '/emails/add') {
    const email = normalizeEmail(String(body['email'] ?? ''));
    if (!isValidEmailAddress(email)) {
      sendBadRequest(res, 'That is not an email address.');
      return true;
    }
    if (fakeAddresses.has(email)) {
      // Cloudflare's own refusal, in the shape the admin surfaces it.
      sendBadRequest(res, 'That address is already a destination address.');
      return true;
    }

    const address = addFakeAddress(email);
    const at = now();
    await mutateNotificationState(store, (state) => ({
      state: {
        ...state,
        recipients: {
          ...state.recipients,
          [email]: newRecipient(at),
        },
      },
      value: undefined,
    }));

    sendJson(res, 200, {
      recipient: { ...recipientRow(address, await notificationState()) },
    });
    return true;
  }

  if (route === '/emails/remove') {
    const id = String(body['id'] ?? '');
    const address = listFakeAddresses().find((candidate) => candidate.id === id);
    if (!address) {
      sendNotFound(res);
      return true;
    }
    fakeAddresses.delete(address.email);
    await mutateNotificationState(store, (state) => {
      if (!state.recipients[address.email]) return { state, value: undefined };
      const recipients = { ...state.recipients };
      delete recipients[address.email];
      return { state: { ...state, recipients }, value: undefined };
    });
    sendJson(res, 200, { removed: address.email });
    return true;
  }

  // The three switches, which differ only in which bit they set and whether
  // the digest's clock starts. The real function has one handler for the same
  // reason.
  const SWITCHES: Record<string, 'enabled' | 'canSubmit' | 'reviewsInbox'> = {
    '/emails/set-enabled': 'enabled',
    '/emails/set-submit': 'canSubmit',
    '/emails/set-reviews': 'reviewsInbox',
  };
  const which = SWITCHES[route];
  if (which) {
    const email = normalizeEmail(String(body['email'] ?? ''));
    const value = body[which] === true;
    const address = fakeAddresses.get(email);
    if (!address?.verified) {
      sendNotFound(res);
      return true;
    }

    const at = now();
    const state = await mutateNotificationState(store, (current) => {
      const existing: RecipientState =
        current.recipients[email] ?? newRecipient(at, false);
      const startingDigest = which === 'enabled' && value && !existing.enabled;
      const updated: NotificationState = {
        ...current,
        recipients: {
          ...current.recipients,
          [email]: {
            ...existing,
            [which]: value,
            seenThrough: startingDigest ? at : existing.seenThrough,
          },
        },
      };
      return { state: updated, value: updated };
    });

    sendJson(res, 200, { recipient: recipientRow(address, state) });
    return true;
  }

  if (route === '/emails/test') {
    const email = normalizeEmail(String(body['email'] ?? ''));
    const outcome = await fakeNotifyTest(email);
    if (!outcome) {
      // Production gets a plain 404 from the Worker and says only this much.
      sendJson(res, 500, {
        error:
          'The test could not be sent. Check that the address is verified and ' +
          'that the mail Worker is configured.',
      });
      return true;
    }
    sendJson(res, 200, outcome);
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// The Inbox, faked
// ---------------------------------------------------------------------------

/**
 * The inbox routes run the *real* repository over the in-memory store, so the
 * claim's conditional write, the token check on every later write, and the
 * listing order are the real ones. What is faked is the two things a laptop
 * cannot have: Cloudflare Email Routing delivering a message, and a presigned
 * R2 GET.
 *
 * `POST /__dev/inbox` stands in for the first. It takes a multipart form of
 * files plus `from` and `subject`, sniffs the parts exactly as the Worker
 * does, and builds a `Submission` the same way — so the Inbox page is
 * developable and testable without a domain.
 */
async function handleDevSubmission(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);

  const form = await new Response(Buffer.concat(chunks), {
    headers: { 'content-type': req.headers['content-type'] ?? '' },
  }).formData();

  const from = normalizeEmail(String(form.get('from') ?? ''));
  const subject = String(form.get('subject') ?? '').trim() || null;
  const bodyText = String(form.get('body') ?? '') || null;

  // The Worker refuses a sender who is not an allowed, verified, switched-on
  // address; the fixture refuses the same way so the rule is exercisable.
  const address = fakeAddresses.get(from);
  const state = await notificationState();
  if (!address?.verified || !state.recipients[from]?.canSubmit) {
    sendJson(res, 403, { error: 'That address may not submit.' });
    return true;
  }

  // Any field whose name starts with `file`, in the order the form lists them.
  // Several rather than one repeated name because Playwright's multipart helper
  // takes an object, and an object cannot hold the same key twice.
  const candidates: { filename: string | null; bytes: Uint8Array }[] = [];
  for (const [name, entry] of form.entries()) {
    if (!name.startsWith('file') || typeof entry === 'string') continue;
    candidates.push({
      filename: entry.name || null,
      bytes: new Uint8Array(await entry.arrayBuffer()),
    });
  }

  const selected = selectImageParts(candidates);
  if (selected.length === 0) {
    // The Worker bounces here; there is nothing to bounce to locally.
    sendJson(res, 400, { error: 'No photos were found in that message.' });
    return true;
  }

  const submission: Submission = {
    schemaVersion: SUBMISSION_SCHEMA_VERSION,
    id: generatePhotoId(),
    receivedAt: now(),
    submittedBy: address.id,
    subject,
    proposedCaption: proposeCaption(subject, bodyText),
    bodyLine: firstBodyLine(bodyText),
    parts: selected.map((part) => ({
      index: part.index,
      filename: part.filename,
      contentType: part.contentType,
      bytes: part.bytes.byteLength,
    })),
    claim: null,
  };

  await storeSubmission(store, submission, selected);
  sendJson(res, 200, { id: submission.id, parts: submission.parts.length });
  return true;
}

/**
 * The stand-in for a presigned R2 GET of one raw part.
 *
 * It honours `Range`, because the Inbox's thumbnail read depends on it and a
 * fake that always returned the whole object would hide exactly the failure
 * the bucket's CORS rule exists to prevent.
 */
async function serveInboxPart(
  req: IncomingMessage,
  res: ServerResponse,
  submissionId: string,
  index: number,
): Promise<boolean> {
  const stored = await store.get(submissionPartKey(submissionId, index));
  if (!stored) {
    sendNotFound(res);
    return true;
  }

  const loaded = await loadSubmission(store, submissionId);
  const contentType =
    loaded?.submission.parts.find((part) => part.index === index)?.contentType ??
    'application/octet-stream';

  const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers['range'] ?? ''));
  if (range) {
    const start = Number(range[1]);
    const end = Math.min(
      range[2] === '' ? stored.body.byteLength - 1 : Number(range[2]),
      stored.body.byteLength - 1,
    );
    const slice = stored.body.slice(start, end + 1);
    res.writeHead(206, {
      'content-type': contentType,
      'content-range': `bytes ${start}-${end}/${stored.body.byteLength}`,
      'content-length': String(slice.byteLength),
    });
    res.end(Buffer.from(slice));
    return true;
  }

  res.writeHead(200, {
    'content-type': contentType,
    'content-length': String(stored.body.byteLength),
  });
  res.end(Buffer.from(stored.body));
  return true;
}

async function handleInbox(
  route: string,
  method: string,
  body: Body,
  url: URL,
  res: ServerResponse,
): Promise<boolean> {
  if (method === 'GET' && route === '/inbox') {
    const submissions = await listSubmissions(store);
    const byId = new Map(listFakeAddresses().map((address) => [address.id, address]));
    const at = Date.now();
    sendJson(res, 200, {
      submissions: submissions.map((submission) => ({
        id: submission.id,
        receivedAt: submission.receivedAt,
        from: byId.get(submission.submittedBy)?.email ?? null,
        subject: submission.subject,
        proposedCaption: submission.proposedCaption,
        bodyLine: submission.bodyLine,
        parts: submission.parts,
        claimedAt: submission.claim?.at ?? null,
        claimExpired: submission.claim !== null && !isClaimLive(submission, at),
      })),
      claimTtlMinutes: INBOX_CLAIM_TTL_MINUTES,
    });
    return true;
  }

  if (method === 'GET' && route === '/inbox/count') {
    sendJson(res, 200, { count: (await listSubmissions(store)).length });
    return true;
  }

  if (method === 'GET' && route === '/inbox/part-url') {
    const submissionId = url.searchParams.get('submission') ?? '';
    const index = Number(url.searchParams.get('part'));
    if (!isValidSubmissionId(submissionId) || !Number.isInteger(index)) {
      sendNotFound(res);
      return true;
    }
    const loaded = await loadSubmission(store, submissionId);
    const part = loaded?.submission.parts.find(
      (candidate) => candidate.index === index,
    );
    if (!part) {
      sendNotFound(res);
      return true;
    }
    sendJson(res, 200, {
      // Production returns a presigned R2 URL; locally this is the fixture's
      // own part route, which honours Range the same way.
      url: `/__inbox-part/${submissionId}/${index}`,
      contentType: part.contentType,
      bytes: part.bytes,
      expiresAt: new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString(),
    });
    return true;
  }

  if (method !== 'POST') return false;

  const submissionId = String(body['submissionId'] ?? '');
  const claimToken = String(body['claimToken'] ?? '');
  if (!isValidSubmissionId(submissionId) || claimToken.length < 8) {
    sendNotFound(res);
    return true;
  }

  if (route === '/inbox/claim') {
    const outcome = await claimSubmission(store, submissionId, claimToken, now());
    if (outcome.status === 'not-found') sendNotFound(res);
    else if (outcome.status === 'claimed') sendJson(res, 200, { status: 'claimed' });
    else if (outcome.status === 'conflict') sendJson(res, 200, { status: 'conflict' });
    else
      sendJson(res, 200, {
        status: 'held',
        claimedAt: outcome.submission.claim?.at ?? null,
        claimAgeMs:
          Date.now() -
          Date.parse(outcome.submission.claim?.at ?? new Date(0).toISOString()),
      });
    return true;
  }

  if (route === '/inbox/resolve' || route === '/inbox/discard') {
    const outcome = await removeSubmission(store, submissionId, claimToken);
    if (outcome.status === 'refused') sendNotFound(res);
    else sendJson(res, 200, { status: 'removed' });
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Admin API
// ---------------------------------------------------------------------------

interface Body {
  [key: string]: unknown;
}

async function handleAdmin(
  route: string,
  method: string,
  body: Body,
  url: URL,
  res: ServerResponse,
): Promise<boolean> {
  // Answered here and nowhere else. This handler is otherwise more permissive
  // than production — an unrecognized GET falls through to handleDisplay,
  // which once hid the admin API missing the viewer's read routes entirely
  // (CLAUDE.md) — so an unknown /emails or /inbox path is a 404 here,
  // as it is in the real function.
  if (route === '/emails' || route.startsWith('/emails/')) {
    if (await handleEmails(route, method, body, res)) return true;
    sendNotFound(res);
    return true;
  }

  if (route === '/inbox' || route.startsWith('/inbox/')) {
    if (await handleInbox(route, method, body, url, res)) return true;
    sendNotFound(res);
    return true;
  }

  if (method === 'GET') {
    if (route === '/trash') {
      const catalog = await currentCatalog();
      const items = trashedPhotos(catalog)
        .map((photo) => ({
          photo: toPublicPhoto(photo),
          trashedAt: photo.trashedAt,
          // Production signs a grant per rendition; locally the signed route
          // is unsigned, so the trash's grid and photo view are exercisable.
          // Never `full`: a trashed photo must not be downloadable.
          thumbnailUrl: `/d/${photo.id}/thumb`,
          previewUrl: `/d/${photo.id}/display-1280`,
        }))
        .sort((a, b) => (a.trashedAt! < b.trashedAt! ? 1 : -1));
      sendJson(res, 200, {
        items,
        expiresAt: new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString(),
      });
      return true;
    }

    if (route === '/trash/count') {
      sendJson(res, 200, { count: trashedPhotos(await currentCatalog()).length });
      return true;
    }

    if (route === '/export') {
      const catalog = await currentCatalog();
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': 'attachment; filename="photo-catalog.json"',
      });
      res.end(JSON.stringify(catalog, null, 2));
      return true;
    }

    const attribution = /^\/attribution\/([0-9a-f]{32})$/.exec(route);
    if (attribution) {
      const photo = (await currentCatalog()).photos[attribution[1]!];
      const id = photo?.submittedBy ?? null;
      const address = id
        ? listFakeAddresses().find((candidate) => candidate.id === id)
        : undefined;
      sendJson(res, 200, { email: address?.email ?? null });
      return true;
    }

    return handleDisplay(route, res);
  }

  if (method !== 'POST') return false;

  switch (route) {
    case '/begin-batch': {
      const batchSeq = await mutateCatalog(store, context, beginBatch, {
        snapshot: false,
      });
      sendJson(res, 200, { batchSeq });
      return true;
    }

    case '/prepare': {
      const hash = String(body['contentHash'] ?? '');
      const filename = String(body['originalFilename'] ?? '');
      const catalog = await currentCatalog();
      const existing = Object.values(catalog.photos).find(
        (photo) => photo.contentHash === hash,
      );
      if (existing) {
        sendJson(res, 200, {
          status: 'duplicate',
          existingId: existing.id,
          existingTrashed: existing.trashedAt !== null,
        });
        return true;
      }
      const photoId = generatePhotoId();
      sendJson(res, 200, {
        status: 'ready',
        photoId,
        downloadFilename: downloadFilenameFor(filename, photoId),
        // Local upload sink; production returns presigned R2 URLs.
        uploads: Object.fromEntries(
          (Object.keys(RENDITION_SPECS) as Rendition[]).map((rendition) => [
            rendition,
            `/__upload/${photoId}/${rendition}`,
          ]),
        ),
      });
      return true;
    }

    case '/commit': {
      const auditId = generateAuditId();
      const at = now();

      // Attribution is resolved from the stored submission record, never taken
      // from the request — the same rule the real function applies, and the
      // reason it is worth having here rather than only in production.
      let submittedBy: string | null = null;
      const submissionId = String(body['submissionId'] ?? '');
      if (submissionId !== '') {
        const loaded = await loadSubmission(store, submissionId);
        if (!loaded || loaded.submission.claim?.token !== String(body['claimToken'])) {
          sendNotFound(res);
          return true;
        }
        submittedBy = loaded.submission.submittedBy;
      }

      const outcome = await mutateCatalog(store, context, (catalog) =>
        commitPhoto(
          catalog,
          {
            id: String(body['photoId']),
            contentHash: String(body['contentHash']),
            originalFilename: String(body['originalFilename']),
            downloadFilename: downloadFilenameFor(
              String(body['originalFilename']),
              String(body['photoId']),
            ),
            sourceMimeType: String(body['sourceMimeType']),
            captureDate: (body['captureDate'] as string | null) ?? null,
            captureTime: (body['captureTime'] as string | null) ?? null,
            captureUtcOffset: (body['captureUtcOffset'] as string | null) ?? null,
            timestampSource: body['timestampSource'] as never,
            caption: (body['caption'] as string | null) ?? null,
            submittedBy,
            batchSeq: Number(body['batchSeq']),
            selectionIndex: Number(body['selectionIndex']),
            derivatives: body['derivatives'] as never,
          },
          at,
          auditId,
        ),
      );
      sendJson(
        res,
        200,
        outcome.status === 'duplicate'
          ? {
              status: 'duplicate',
              existingId: outcome.existingId,
              existingTrashed: outcome.existingTrashed,
            }
          : { status: 'created', photo: toPublicPhoto(outcome.photo) },
      );
      return true;
    }

    case '/edit': {
      const outcome = await mutateCatalog(store, context, (catalog) =>
        editPhotoMetadata(
          catalog,
          String(body['photoId']),
          body as never,
          now(),
          generateAuditId(),
        ),
      );
      if (outcome.status === 'not-found') sendNotFound(res);
      else if (outcome.status === 'invalid') sendBadRequest(res, outcome.error);
      else sendJson(res, 200, { photo: toPublicPhoto(outcome.photo) });
      return true;
    }

    case '/captions': {
      // Hoisted out of the mutation, as production does: a retry after a
      // conflict must write the same instant and audit id.
      const at = now();
      const auditId = generateAuditId();
      const outcome = await mutateCatalog(store, context, (catalog) =>
        applyCaptions(catalog, body['changes'], at, auditId),
      );
      if (outcome.status === 'invalid') sendBadRequest(res, outcome.error);
      else {
        sendJson(res, 200, {
          updated: outcome.updated.map(toPublicPhoto),
          skipped: outcome.skipped,
        });
      }
      return true;
    }

    case '/trash/preview': {
      const catalog = await currentCatalog();
      const photoIds = resolveSelection(catalog, body['selection'] as SelectionQuery);
      sendJson(res, 200, {
        photoIds,
        count: photoIds.length,
        expiresAt: Math.floor(Date.now() / 1000) + 600,
        // Production signs an HMAC over the exact ID list; locally the list is
        // still what the confirm acts on, which is the behaviour under test.
        token: 'development-token',
      });
      return true;
    }

    case '/trash/confirm': {
      const ids = (body['photoIds'] as string[]) ?? [];
      const outcome = await mutateCatalog(store, context, (catalog) =>
        trashPhotos(catalog, ids, now(), generateAuditId()),
      );
      sendJson(res, 200, { trashed: outcome.affected, count: outcome.affected.length });
      return true;
    }

    case '/restore': {
      const ids = (body['photoIds'] as string[]) ?? [];
      const outcome = await mutateCatalog(store, context, (catalog) =>
        restorePhotos(catalog, ids, now(), generateAuditId()),
      );
      sendJson(res, 200, {
        restored: outcome.affected,
        count: outcome.affected.length,
      });
      return true;
    }

    case '/permanent-delete/preview': {
      const selection = body['selection'] as SelectionQuery;
      const ids =
        selection.kind === 'ids'
          ? resolveTrashedSelection(await currentCatalog(), selection.photoIds)
          : [];
      sendJson(res, 200, {
        photoIds: ids,
        count: ids.length,
        expiresAt: Math.floor(Date.now() / 1000) + 600,
        token: 'development-token',
      });
      return true;
    }

    case '/permanent-delete/confirm': {
      const ids = (body['photoIds'] as string[]) ?? [];
      const outcome = await mutateCatalog(store, context, (catalog) =>
        permanentlyDeletePhotos(catalog, ids),
      );
      for (const id of outcome.affected) {
        for (const rendition of Object.keys(RENDITION_SPECS)) {
          uploadedObjects.delete(`${id}/${rendition}`);
        }
      }
      sendJson(res, 200, { deleted: outcome.affected, count: outcome.affected.length });
      return true;
    }

    default:
      return false;
  }
}

// ---------------------------------------------------------------------------

async function handle(
  req: IncomingMessage,
  url: URL,
  res: ServerResponse,
): Promise<boolean> {
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // Local stand-in for a presigned R2 PUT.
  const upload = /^\/__upload\/([0-9a-f]{32})\/([a-z0-9-]+)$/.exec(path);
  if (upload && method === 'PUT') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    uploadedObjects.set(
      `${upload[1]}/${upload[2]}`,
      new Uint8Array(Buffer.concat(chunks)),
    );
    res.writeHead(200).end();
    return true;
  }

  // Local stand-in for Cloudflare Email Routing delivering a message, and for
  // a presigned R2 GET of one raw part. Development only, both.
  if (path === '/__dev/inbox' && method === 'POST') {
    return handleDevSubmission(req, res);
  }

  const inboxPart = /^\/__inbox-part\/([0-9a-f]{32})\/(\d+)$/.exec(path);
  if (inboxPart) {
    return serveInboxPart(req, res, inboxPart[1]!, Number(inboxPart[2]));
  }

  const capability = /^\/p\/([0-9a-f]{32})\/([a-z0-9-]+)$/.exec(path);
  if (capability) return serveAsset(res, capability[1]!, capability[2]!, false);

  const signed = /^\/d\/([0-9a-f]{32})\/([a-z0-9-]+)$/.exec(path);
  if (signed) return serveAsset(res, signed[1]!, signed[2]!, true);

  const api = /^\/([^/]+)\/api(\/.*)?$/.exec(path);
  if (!api) return false;

  const base = api[1]!;
  const route = api[2] ?? '/';
  // Which app is asking is decided by the base path, exactly as the Edge
  // Function decides access mode in production.
  const isAdmin = base === (process.env.ADMIN_PATH || 'dev-admin-path');

  if (isAdmin) {
    return handleAdmin(route, method, (await readBody(req)) as Body, url, res);
  }
  if (method !== 'GET') {
    sendNotFound(res);
    return true;
  }
  if (await handleDisplay(route, res)) return true;

  sendNotFound(res);
  return true;
}

export function fixtureServer(): Plugin {
  return {
    name: 'photo-fixture-server',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(
        (req: IncomingMessage, res: ServerResponse, next: () => void) => {
          const url = new URL(req.url ?? '/', 'http://localhost');
          handle(req, url, res).then(
            (handled) => {
              if (!handled) next();
            },
            (error: unknown) => {
              console.error('Fixture server error', error);
              sendJson(res, 500, { error: 'Fixture server error' });
            },
          );
        },
      );
    },
  };
}
