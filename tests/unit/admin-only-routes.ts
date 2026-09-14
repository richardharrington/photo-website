import { FIXTURE_PHOTO_IDS } from '../../fixtures/catalog.ts';

/**
 * Every route only the admin link may call (family-tier.md #4), with a body
 * that would do something if it were answered.
 *
 * Shared by the two tier tests — the real Functions' and the fixture
 * server's — so the list the family link is refused is one list in both.
 */
export const ADMIN_ONLY_ROUTES: readonly {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
}[] = [
  { method: 'GET', path: '/export' },
  { method: 'GET', path: `/attribution/${FIXTURE_PHOTO_IDS['beach-early']!}` },
  { method: 'GET', path: '/emails' },
  { method: 'GET', path: '/inbox' },
  { method: 'GET', path: '/inbox/count' },
  { method: 'GET', path: `/inbox/part-url?submission=${'a'.repeat(32)}&part=0` },
  { method: 'POST', path: '/captions', body: { changes: [] } },
  {
    method: 'POST',
    path: '/permanent-delete/preview',
    body: { selection: { kind: 'ids', photoIds: [FIXTURE_PHOTO_IDS['deleted-0']!] } },
  },
  {
    method: 'POST',
    path: '/permanent-delete/confirm',
    body: { photoIds: [FIXTURE_PHOTO_IDS['deleted-0']!], expiresAt: 0, token: 'x' },
  },
  { method: 'POST', path: '/emails/add', body: { email: 'someone@example.test' } },
  { method: 'POST', path: '/emails/remove', body: { id: 'x' } },
  { method: 'POST', path: '/emails/set-enabled', body: {} },
  { method: 'POST', path: '/emails/set-submit', body: {} },
  { method: 'POST', path: '/emails/set-reviews', body: {} },
  { method: 'POST', path: '/emails/test', body: {} },
  { method: 'POST', path: '/inbox/claim', body: {} },
  { method: 'POST', path: '/inbox/resolve', body: {} },
  { method: 'POST', path: '/inbox/discard', body: {} },
];
