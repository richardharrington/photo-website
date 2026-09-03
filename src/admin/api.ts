/**
 * Admin API client.
 *
 * The reads are the shared read client, unchanged: the admin renders the same
 * timeline and the same photo view the viewer does, so it asks for exactly
 * what the viewer asks for. What this module adds is the mutations, and the
 * error parsing they need — an admin acts on the library and has to be told
 * why something was refused, where a viewer only ever reads.
 *
 * Both halves live below this build's own opaque base.
 */

import { readApi, routes } from '../shared/ui/api.ts';
import { NotFoundError } from '../shared/ui/useResource.ts';
import type { PublicPhoto } from '../shared/display-api.ts';
import type { PhotoEdit } from '../shared/ui/curation.ts';
import type { SelectionQuery } from '../shared/admin-operations.ts';
import type { Rendition } from '../shared/constants.ts';
import type { DerivativeDescriptor } from '../shared/catalog.ts';

export { routes };

/** A rejection the API explains, as opposed to a bare failure. */
export class ApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(routes.api(path), {
    ...init,
    headers: { accept: 'application/json', ...init?.headers },
    credentials: 'omit',
  });

  if (response.status === 404) throw new NotFoundError();
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(body?.error ?? `Request failed (${response.status}).`);
  }
  return (await response.json()) as T;
}

function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
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
  photoId?: string;
  downloadFilename?: string;
  uploads?: Record<Rendition, string>;
}

export interface CommitResult {
  status: 'created' | 'duplicate';
  existingId?: string;
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

export const adminApi = {
  // ---- Reads ------------------------------------------------------------
  // The viewer's own projections, verbatim.
  ...readApi,

  trash: (signal?: AbortSignal) =>
    request<TrashListing>('/trash', { signal: signal ?? null }),

  trashCount: (signal?: AbortSignal) =>
    request<{ count: number }>('/trash/count', { signal: signal ?? null }),

  // ---- Upload flow ------------------------------------------------------
  beginBatch: () => post<{ batchSeq: number }>('/begin-batch', {}),

  prepare: (contentHash: string, originalFilename: string) =>
    post<PrepareResult>('/prepare', { contentHash, originalFilename }),

  commit: (body: {
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
  }) => post<CommitResult>('/commit', body),

  // ---- Curation ---------------------------------------------------------
  edit: (photoId: string, edit: PhotoEdit) =>
    post<{ photo: PublicPhoto }>('/edit', { photoId, ...edit }),

  /**
   * Both halves of a destructive action. The preview resolves a selection to
   * an explicit ID list and returns a token bound to it; the confirm sends
   * that same list back. A photo committed in between is not in the list the
   * token covers (decisions.md #12).
   */
  previewTrash: (selection: SelectionQuery) =>
    post<PreviewResult>('/trash/preview', { selection }),

  confirmTrash: (preview: PreviewResult) =>
    post<{ trashed: string[]; count: number }>('/trash/confirm', {
      photoIds: preview.photoIds,
      expiresAt: preview.expiresAt,
      token: preview.token,
    }),

  previewPermanentDelete: (photoIds: string[]) =>
    post<PreviewResult>('/permanent-delete/preview', {
      selection: { kind: 'ids', photoIds },
    }),

  confirmPermanentDelete: (preview: PreviewResult) =>
    post<{ deleted: string[]; count: number }>('/permanent-delete/confirm', {
      photoIds: preview.photoIds,
      expiresAt: preview.expiresAt,
      token: preview.token,
    }),

  /** The Undo behind a just-completed trash action. */
  restore: (photoIds: string[]) =>
    post<{ restored: string[]; count: number }>('/restore', { photoIds }),

  exportUrl: () => routes.api('/export'),
};
