/**
 * The preview/confirm tokens both destructive flows use (decisions.md #12).
 *
 * A preview resolves a selection to an explicit list of photo IDs and signs a
 * token bound to that list, its expiry, and the kind of act. The confirm step
 * never re-runs the query: it verifies the token over the list the browser
 * sends back and acts on exactly that list, so a photo committed between
 * preview and confirm cannot be swept in unseen.
 *
 * Its own module because the Functions share it: both destructive flows are
 * curation routes now (curation-routes.ts), which both Functions answer. The
 * `action` a token is bound to is what keeps the two apart — a trash token
 * cannot confirm a permanent delete, whichever Function receives it.
 */

import { isValidPhotoId } from '../../../src/shared/ids.ts';
import { signConfirmation, verifyConfirmation } from '../../../src/shared/signing.ts';
import { badRequest, json, nowSeconds, readJson, requiredEnv } from './http.ts';

/** How long a preview's confirmation token stays valid. */
const CONFIRMATION_TTL_SECONDS = 10 * 60;

export type ConfirmationAction = 'trash' | 'permanent-delete';

/** The preview response: the resolved list and a token bound to it. */
export async function issueConfirmation(
  action: ConfirmationAction,
  photoIds: string[],
): Promise<Response> {
  const expiresAt = nowSeconds() + CONFIRMATION_TTL_SECONDS;
  const token = await signConfirmation(requiredEnv('ASSET_SIGNING_KEY'), {
    action,
    photoIds,
    expiresAt,
  });

  return json({ photoIds, count: photoIds.length, expiresAt, token });
}

interface ConfirmBody {
  photoIds?: string[];
  expiresAt?: number;
  token?: string;
}

/**
 * Verify a confirm request against the token its preview issued.
 *
 * Resolves with the photo IDs to act on, or the refusal to send back.
 */
export async function readConfirmation(
  request: Request,
  action: ConfirmationAction,
): Promise<{ photoIds: string[] } | Response> {
  const body = await readJson<ConfirmBody>(request);
  if (
    !body?.token ||
    typeof body.expiresAt !== 'number' ||
    !Array.isArray(body.photoIds)
  ) {
    return badRequest(
      'A confirmation token, its expiry, and its photo IDs are required.',
    );
  }
  if (!body.photoIds.every((id) => typeof id === 'string' && isValidPhotoId(id))) {
    return badRequest('photoIds contains a malformed ID.');
  }

  const verified = await verifyConfirmation(
    requiredEnv('ASSET_SIGNING_KEY'),
    { action, photoIds: body.photoIds, expiresAt: body.expiresAt },
    body.token,
    nowSeconds(),
  );

  if (!verified.ok) {
    return badRequest(
      verified.reason === 'expired'
        ? 'That confirmation has expired. Please review the selection again.'
        : 'That confirmation does not match the selection it was issued for.',
    );
  }

  return { photoIds: body.photoIds };
}
