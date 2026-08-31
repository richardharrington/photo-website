/**
 * Admin API client.
 *
 * Reads go through the same display endpoints the viewer uses — the admin
 * extends the display hierarchy rather than duplicating it — while mutations
 * are admin-only. Both live below this build's own opaque base.
 */

import { appRoutes } from '../shared/urls.ts';
import { NotFoundError } from '../shared/ui/useResource.ts';
import type {
  GroupResponse,
  HierarchyResponse,
  PhotoResponse,
  PublicPhoto,
} from '../shared/display-api.ts';
import type { SelectionQuery } from '../shared/admin-operations.ts';
import type { Rendition } from '../shared/constants.ts';
import type { DerivativeDescriptor } from '../shared/catalog.ts';

export const routes = appRoutes(__APP_BASE__);

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

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
  thumbnailUrl: string;
}

export const adminApi = {
  // ---- Reads ------------------------------------------------------------
  hierarchy: (signal?: AbortSignal) =>
    request<HierarchyResponse>('/hierarchy', { signal: signal ?? null }),

  day: (year: number, month: number, day: number, signal?: AbortSignal) =>
    request<GroupResponse>(`/day/${year}/${pad2(month)}/${pad2(day)}`, {
      signal: signal ?? null,
    }),

  undated: (signal?: AbortSignal) =>
    request<GroupResponse>('/undated', { signal: signal ?? null }),

  photo: (id: string, signal?: AbortSignal) =>
    request<PhotoResponse>(`/photo/${id}`, { signal: signal ?? null }),

  trash: (signal?: AbortSignal) =>
    request<{ items: TrashItem[] }>('/trash', { signal: signal ?? null }),

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
  edit: (
    photoId: string,
    edit: { date: string | null; time: string | null; caption: string | null },
  ) => post<{ photo: PublicPhoto }>('/edit', { photoId, ...edit }),

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

  downloadLink: (photoId: string) =>
    request<{ url: string; expiresAt: string; filename: string }>(
      `/download/${photoId}`,
    ),

  exportUrl: () => routes.api('/export'),
};
