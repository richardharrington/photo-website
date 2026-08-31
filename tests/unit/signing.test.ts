import { describe, it, expect } from 'vitest';
import {
  assetGrantPath,
  signAssetGrant,
  signConfirmation,
  timingSafeEqualHex,
  verifyAssetGrant,
  verifyConfirmation,
} from '../../src/shared/signing.ts';

const KEY = 'test-signing-key-not-a-real-secret';
const OTHER_KEY = 'a-different-key';
const NOW = 1_800_000_000;

const grant = {
  photoId: 'a'.repeat(32),
  rendition: 'full',
  expiresAt: NOW + 300,
};

describe('timingSafeEqualHex', () => {
  it('compares equal-length strings', () => {
    expect(timingSafeEqualHex('abcd', 'abcd')).toBe(true);
    expect(timingSafeEqualHex('abcd', 'abce')).toBe(false);
  });

  it('rejects a length mismatch', () => {
    expect(timingSafeEqualHex('abcd', 'abc')).toBe(false);
    expect(timingSafeEqualHex('', 'a')).toBe(false);
  });
});

describe('asset grants', () => {
  it('verifies a signature it just produced', async () => {
    const signature = await signAssetGrant(KEY, grant);
    expect(await verifyAssetGrant(KEY, grant, signature, NOW)).toEqual({ ok: true });
  });

  it('rejects a signature made with a different key', async () => {
    const signature = await signAssetGrant(OTHER_KEY, grant);
    expect(await verifyAssetGrant(KEY, grant, signature, NOW)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('rejects an expired grant', async () => {
    const signature = await signAssetGrant(KEY, grant);
    const result = await verifyAssetGrant(KEY, grant, signature, grant.expiresAt + 1);
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('accepts a grant at the exact expiry second', async () => {
    const signature = await signAssetGrant(KEY, grant);
    expect(await verifyAssetGrant(KEY, grant, signature, grant.expiresAt)).toEqual({
      ok: true,
    });
  });

  it('cannot be replayed against a different photo', async () => {
    const signature = await signAssetGrant(KEY, grant);
    const elsewhere = { ...grant, photoId: 'b'.repeat(32) };

    expect(await verifyAssetGrant(KEY, elsewhere, signature, NOW)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('cannot be escalated from a thumbnail to the full original', async () => {
    // The rendition is inside the signed payload, so a trash-view thumbnail
    // link cannot be edited into a full-resolution download.
    const thumb = { ...grant, rendition: 'thumb' };
    const signature = await signAssetGrant(KEY, thumb);

    expect(
      await verifyAssetGrant(KEY, { ...thumb, rendition: 'full' }, signature, NOW),
    ).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('cannot have its expiry extended', async () => {
    const signature = await signAssetGrant(KEY, grant);
    const extended = { ...grant, expiresAt: grant.expiresAt + 86_400 };

    expect(await verifyAssetGrant(KEY, extended, signature, NOW)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('reports a bad signature even when the grant has also expired', async () => {
    // Checking expiry first would let an attacker distinguish "wrong
    // signature" from "right signature, too late" without ever holding a
    // valid one.
    const result = await verifyAssetGrant(
      KEY,
      grant,
      'f'.repeat(64),
      grant.expiresAt + 10_000,
    );
    expect(result).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('builds a URL path carrying the expiry and signature', async () => {
    const signature = await signAssetGrant(KEY, grant);
    const path = assetGrantPath(grant, signature);

    expect(path.startsWith(`/d/${grant.photoId}/full?`)).toBe(true);
    const query = new URLSearchParams(path.slice(path.indexOf('?') + 1));
    expect(query.get('exp')).toBe(String(grant.expiresAt));
    expect(query.get('sig')).toBe(signature);
  });
});

describe('confirmation tokens', () => {
  const ids = ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)];
  const confirmation = { action: 'trash', photoIds: ids, expiresAt: NOW + 300 };

  it('verifies the exact list it was issued for', async () => {
    const token = await signConfirmation(KEY, confirmation);
    expect(await verifyConfirmation(KEY, confirmation, token, NOW)).toEqual({
      ok: true,
    });
  });

  it('does not depend on the order the UI collected the selection in', async () => {
    const token = await signConfirmation(KEY, confirmation);
    const reordered = { ...confirmation, photoIds: [...ids].reverse() };

    expect(await verifyConfirmation(KEY, reordered, token, NOW)).toEqual({
      ok: true,
    });
  });

  it('refuses a list with a photo added after the preview', async () => {
    // The race decisions.md #12 closes: a photo committed between preview and
    // confirm must not be swept in silently.
    const token = await signConfirmation(KEY, confirmation);
    const widened = { ...confirmation, photoIds: [...ids, 'd'.repeat(32)] };

    expect(await verifyConfirmation(KEY, widened, token, NOW)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('refuses a list with a photo removed', async () => {
    const token = await signConfirmation(KEY, confirmation);
    const narrowed = { ...confirmation, photoIds: ids.slice(0, 2) };

    expect(await verifyConfirmation(KEY, narrowed, token, NOW)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('does not let a trash token authorize a permanent delete', async () => {
    const token = await signConfirmation(KEY, confirmation);
    const escalated = { ...confirmation, action: 'permanent-delete' };

    expect(await verifyConfirmation(KEY, escalated, token, NOW)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('expires', async () => {
    const token = await signConfirmation(KEY, confirmation);
    const result = await verifyConfirmation(
      KEY,
      confirmation,
      token,
      confirmation.expiresAt + 1,
    );

    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('produces different tokens for different actions on the same list', async () => {
    const trash = await signConfirmation(KEY, confirmation);
    const destroy = await signConfirmation(KEY, {
      ...confirmation,
      action: 'permanent-delete',
    });

    expect(trash).not.toBe(destroy);
  });

  it('handles an empty selection without matching a non-empty one', async () => {
    const empty = { ...confirmation, photoIds: [] };
    const token = await signConfirmation(KEY, empty);

    expect(await verifyConfirmation(KEY, empty, token, NOW)).toEqual({ ok: true });
    expect(await verifyConfirmation(KEY, confirmation, token, NOW)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });
});
