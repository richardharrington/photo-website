/**
 * The curation client both apps share.
 *
 * Everything the family link may do, and so everything the admin does in
 * exactly the same way: the upload flow, editing, moving to the trash and
 * restoring, and the trash listing (family-tier.md #3). These are the routes
 * `netlify/functions/lib/curation-routes.ts` answers for both Functions.
 *
 * Like the read client, it builds every URL through `routes`, which resolves
 * against this build's own opaque base — so the family bundle reaches the
 * display API and the admin bundle the admin API, with nothing injected. What
 * only the administrator does stays in `src/admin/api.ts`, which spreads this
 * in and adds its own.
 *
 * The error parsing lives here because a mutation that is refused has to say
 * why, where a read only ever succeeds or 404s.
 *
 * The family app configures an uploader, and from then on every request here
 * carries its token and every photograph this browser commits is remembered
 * (family-own-trash.md 6.3). The admin never configures one, so its requests
 * carry no token and its uploads are remembered nowhere.
 */

import { routes } from './api.ts';
import { NotFoundError } from './useResource.ts';
import type { PublicPhoto } from '../display-api.ts';
import type { PhotoEdit } from './curation.ts';
import type { SelectionQuery } from '../admin-operations.ts';
import type { Rendition } from '../constants.ts';
import type { DerivativeDescriptor } from '../catalog.ts';
import { UPLOADER_HEADER } from '../uploader.ts';
import type { Uploader } from './uploader.ts';

/** A rejection the API explains, as opposed to a bare failure. */
export class ApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

let uploader: Uploader | null = null;

/** Called once by the family app's entry point. The admin never calls it. */
export function configureUploader(value: Uploader): void {
  uploader = value;
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(routes.api(path), {
    ...init,
    headers: {
      accept: 'application/json',
      ...(uploader ? { [UPLOADER_HEADER]: uploader.token } : {}),
      ...init?.headers,
    },
    credentials: 'omit',
  });

  if (response.status === 404) throw new NotFoundError();
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(body?.error ?? `Request failed (${response.status}).`);
  }
  return (await response.json()) as T;
}

export function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal ?? null,
  });
}

export interface PrepareResult {
  status: 'duplicate' | 'ready';
  existingId?: string;
  /** Set with `existingId`: the duplicate is in the trash, not the library. */
  existingTrashed?: boolean;
  photoId?: string;
  downloadFilename?: string;
  uploads?: Record<Rendition, string>;
}

export interface CommitResult {
  status: 'created' | 'duplicate';
  existingId?: string;
  /** Set with `existingId`: the duplicate is in the trash, not the library. */
  existingTrashed?: boolean;
  photo?: PublicPhoto;
}

export interface PreviewResult {
  photoIds: string[];
  count: number;
  expiresAt: number;
  token: string;
}

export interface TrashItem {
  photo: PublicPhoto;
  trashedAt: string;
  /** Short-lived signed URLs: a trashed photo has no capability URL. */
  thumbnailUrl: string;
  previewUrl: string;
}

export interface TrashListing {
  items: TrashItem[];
  /** When the signed URLs above stop working. */
  expiresAt: string;
}

export const curationApi = {
  // ---- The trash --------------------------------------------------------

  trash: (signal?: AbortSignal) =>
    request<TrashListing>('/trash', { signal: signal ?? null }),

  trashCount: (signal?: AbortSignal) =>
    request<{ count: number }>('/trash/count', { signal: signal ?? null }),

  // ---- Upload flow ------------------------------------------------------
  beginBatch: () => post<{ batchSeq: number }>('/begin-batch', {}),

  prepare: (contentHash: string, originalFilename: string) =>
    post<PrepareResult>('/prepare', { contentHash, originalFilename }),

  commit: async (body: {
    photoId: string;
    contentHash: string;
    originalFilename: string;
    sourceMimeType: string;
    captureDate: string | null;
    captureTime: string | null;
    captureUtcOffset: string | null;
    timestampSource: string;
    caption: string | null;
    batchSeq: number;
    selectionIndex: number;
    derivatives: Record<Rendition, DerivativeDescriptor>;
    /** Set for a photograph coming out of the Inbox. The server resolves the
     *  sender from the record; the browser never supplies one. */
    submissionId?: string;
    claimToken?: string;
  }) => {
    const result = await post<CommitResult>('/commit', body);
    // A duplicate is somebody's photograph already, not this browser's.
    if (result.status === 'created' && result.photo)
      uploader?.remember(result.photo.id);
    return result;
  },

  // ---- Curation ---------------------------------------------------------

  edit: (photoId: string, edit: PhotoEdit) =>
    post<{ photo: PublicPhoto }>('/edit', { photoId, ...edit }),

  /**
   * Both halves of moving photos to the trash. The preview resolves a
   * selection to an explicit ID list and returns a token bound to it; the
   * confirm sends that same list back. A photo committed in between is not in
   * the list the token covers (decisions.md #12).
   */
  previewTrash: (selection: SelectionQuery) =>
    post<PreviewResult>('/trash/preview', { selection }),

  confirmTrash: (preview: PreviewResult) =>
    post<{ trashed: string[]; count: number }>('/trash/confirm', {
      photoIds: preview.photoIds,
      expiresAt: preview.expiresAt,
      token: preview.token,
    }),

  /** Put trashed photos back: the Undo, and the trash's own Restore. */
  restore: (photoIds: string[]) =>
    post<{ restored: string[]; count: number }>('/restore', { photoIds }),
};
