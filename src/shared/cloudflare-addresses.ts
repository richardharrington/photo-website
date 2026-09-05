/**
 * Cloudflare's destination-address API — the recipient list itself.
 *
 * There is no second copy of who exists and who has verified: the account's
 * destination-address list *is* the list (decisions.md, "Notifications"). The
 * Netlify function holds a read+write token and adds and removes; the Worker
 * holds a read-only one and only ever checks whether an address is verified,
 * so the cron can never alter the list.
 *
 * `fetch` is a parameter rather than a global. This module is compiled into
 * all three targets and must stay free of DOM, Node, and Workers globals, and
 * the two runtimes hand it two different implementations. That is also what
 * lets a test drive it with a fake and no network.
 */

import { normalizeEmail } from './notifications.ts';
import type { DestinationAddress } from './notifications.ts';

/**
 * The little of `Response` this needs, declared structurally so it typechecks
 * under all three tsconfigs and accepts either runtime's real `fetch`.
 */
export interface HttpResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<HttpResponseLike>;

/**
 * A refusal from Cloudflare, carrying its own message.
 *
 * Its wording is what the administrator sees when an address is malformed or
 * already present, so it is surfaced rather than replaced: Cloudflare knows
 * why it said no and this code does not.
 */
export class CloudflareApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'CloudflareApiError';
  }
}

/** Cloudflare's envelope. `result` is whatever the endpoint returns. */
interface Envelope {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
  result?: unknown;
}

interface RawAddress {
  id?: unknown;
  email?: unknown;
  /** An ISO instant once confirmed, `null` until then — never a boolean. */
  verified?: unknown;
}

/** Cloudflare's own ceiling. The list will never approach it. */
const PER_PAGE = 50;

function toAddress(raw: RawAddress): DestinationAddress | null {
  if (typeof raw.id !== 'string' || typeof raw.email !== 'string') return null;
  return {
    id: raw.id,
    email: normalizeEmail(raw.email),
    // The one place the timestamp-or-null becomes a boolean.
    verified: typeof raw.verified === 'string' && raw.verified !== '',
  };
}

export interface CloudflareAddressClient {
  list(): Promise<DestinationAddress[]>;
  create(email: string): Promise<DestinationAddress>;
  remove(id: string): Promise<void>;
}

export function cloudflareAddresses(
  fetchImpl: FetchLike,
  accountId: string,
  apiToken: string,
): CloudflareAddressClient {
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/email/routing/addresses`;

  async function call(
    url: string,
    init?: { method?: string; body?: unknown },
  ): Promise<unknown> {
    const response = await fetchImpl(url, {
      method: init?.method ?? 'GET',
      headers: {
        authorization: `Bearer ${apiToken}`,
        'content-type': 'application/json',
      },
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });

    const envelope = (await response.json().catch(() => null)) as Envelope | null;

    if (!response.ok || envelope?.success === false) {
      const message =
        envelope?.errors
          ?.map((error) => error.message)
          .filter(Boolean)
          .join('; ') || `Cloudflare refused the request (${response.status}).`;
      throw new CloudflareApiError(message, response.status);
    }

    return envelope?.result;
  }

  return {
    /**
     * Every destination address in the account, paged until the page is short.
     *
     * The list is account-wide, and the account's Email Routing is used for
     * nothing else, so every verified address in it is a potential recipient.
     */
    async list(): Promise<DestinationAddress[]> {
      const addresses: DestinationAddress[] = [];

      for (let page = 1; ; page += 1) {
        const result = await call(`${base}?per_page=${PER_PAGE}&page=${page}`);
        if (!Array.isArray(result)) break;

        for (const raw of result as RawAddress[]) {
          const address = toAddress(raw);
          if (address) addresses.push(address);
        }

        if (result.length < PER_PAGE) break;
      }

      return addresses.sort((a, b) => (a.email < b.email ? -1 : 1));
    },

    /** Creating an address is what makes Cloudflare send its verify email. */
    async create(email: string): Promise<DestinationAddress> {
      const result = await call(base, { method: 'POST', body: { email } });
      const address = toAddress((result ?? {}) as RawAddress);
      if (!address) {
        throw new CloudflareApiError('Cloudflare returned no address.', 502);
      }
      return address;
    },

    async remove(id: string): Promise<void> {
      await call(`${base}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
  };
}
