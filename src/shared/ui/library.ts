/**
 * The library both apps curate, and every flow that changes it
 * (family-tier.md #11).
 *
 * The family app and the admin render the same listings and the same photo
 * view, and since the family link can delete, edit, and upload too, both need
 * the same machinery around them: the fetched timeline and a patched copy,
 * the single-flight refetch, the trash preview and confirm, the advance after
 * a delete, the five-second undo offer, and the error line. One hook holds
 * all of it, so neither app has its own copy to drift. The admin adds its
 * selection and caption apply on top; the family app adds nothing.
 *
 * A mutation patches the copy from the server's own reply, so the page never
 * waits on a reload, and a background refetch replaces it a moment later so
 * nothing stays out of step for long.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { navigate } from './navigation.ts';
import { useResource } from './useResource.ts';
import type { Resource } from './useResource.ts';
import { readApi, routes } from './api.ts';
import { curationApi } from './curation-api.ts';
import type { PreviewResult } from './curation-api.ts';
import { indexTimeline, recentOrderedIds } from './timeline-index.ts';
import { nextAfterDeleting } from './advance.ts';
import type { PhotoEdit } from './curation.ts';
import { removePhotos, replacePhotosInPlace, upsertPhoto } from '../timeline-patch.ts';
import type { PublicPhoto, TimelineResponse } from '../display-api.ts';
import type { SelectionQuery } from '../admin-operations.ts';

export function photoCount(count: number): string {
  return `${count} photo${count === 1 ? '' : 's'}`;
}

/**
 * Something the undo banner can put back: photos sent to the trash, or the
 * captions an admin's bulk apply replaced.
 */
export interface UndoOffer {
  message: string;
  /**
   * Put it back. Resolving withdraws the offer; rejecting leaves it standing
   * and shows the rejection's message on the error line.
   */
  perform: () => Promise<void>;
}

export interface TrashPreview {
  result: PreviewResult;
  /** The photo the view was on, when the delete came from the photo view. */
  from: string | null;
}

export interface Library {
  /** The library as a resource: fetched, or patched once anything changed. */
  timeline: Resource<TimelineResponse>;
  data: TimelineResponse | null;
  index: ReturnType<typeof indexTimeline> | null;
  /** The order the reader sees: library order, or the recent view's own. */
  orderedIds: readonly string[];
  /** Resolves when the library on the page is up to date. At most one runs. */
  refetch: () => Promise<void>;
  setPatched: Dispatch<SetStateAction<TimelineResponse | null>>;
  /** Swap photos in where they already sit; for changes that cannot move one. */
  patchInPlace: (photos: PublicPhoto[]) => void;

  error: string | null;
  setError: (message: string | null) => void;

  trashCount: number | null;
  countTrashAgain: () => void;

  preview: TrashPreview | null;
  startTrash: (query: SelectionQuery, from: string | null) => Promise<void>;
  confirmTrash: () => Promise<void>;
  cancelTrash: () => void;

  saveEdit: (photoId: string, edit: PhotoEdit) => Promise<PublicPhoto>;

  /** The one standing offer, with the serial that keys its banner. */
  undoOffer: (UndoOffer & { serial: number }) | null;
  offerUndo: (offer: UndoOffer) => void;
  dismissUndo: () => void;
  undo: () => Promise<void>;
}

export function useLibrary({
  onRecent,
}: {
  /** Which listing the reader is in, for the order and the post-delete navigation. */
  onRecent: boolean;
}): Library {
  /**
   * The library as fetched, and as patched.
   *
   * `fetched` loads once and is never re-run: refetching goes through
   * `refetch` below, which replaces the patched copy in place rather than
   * dropping the page back to a loading state.
   */
  const fetched = useResource<TimelineResponse>(
    (signal) => readApi.timeline(signal),
    [],
  );
  const [patched, setPatched] = useState<TimelineResponse | null>(null);
  const data = patched ?? (fetched.status === 'ready' ? fetched.data : null);

  const timeline = useMemo<Resource<TimelineResponse>>(
    () => (data ? { status: 'ready', data, stale: false } : fetched),
    [data, fetched],
  );

  /**
   * At most one refetch in flight; a burst of edits is not a burst of GETs.
   *
   * It resolves when the library on the page is up to date, which the upload
   * panel waits on before it forgets the files it has just added.
   */
  const pendingRefetch = useRef<Promise<void> | null>(null);
  const refetch = useCallback((): Promise<void> => {
    const running = pendingRefetch.current;
    if (running) return running;
    const next = readApi
      .timeline()
      .then((response) => setPatched(response))
      // A failed background refetch leaves the patched copy standing: it is
      // the server's own reply to the mutation, not a guess.
      .catch(() => undefined)
      .finally(() => {
        pendingRefetch.current = null;
      });
    pendingRefetch.current = next;
    return next;
  }, []);

  /**
   * The order everything measures in: whatever is actually on screen.
   *
   * The advance after a delete, and an admin's shift-range and pruning, all
   * take this list. In the Recently Uploaded view the photographs are in a
   * different order, and a range measured in library order would quietly
   * select photographs scattered across years and look as though it had
   * worked.
   */
  const index = useMemo(() => (data ? indexTimeline(data) : null), [data]);
  const orderedIds = useMemo(() => {
    if (!data || !index) return [];
    return onRecent ? recentOrderedIds(data) : index.orderedIds;
  }, [data, index, onRecent]);

  const [error, setError] = useState<string | null>(null);

  const [trashKey, setTrashKey] = useState(0);
  const trash = useResource<{ count: number }>(
    (signal) => curationApi.trashCount(signal),
    [trashKey],
  );
  const trashCount = trash.status === 'ready' ? trash.data.count : null;
  const countTrashAgain = useCallback(() => setTrashKey((key) => key + 1), []);

  /**
   * The one standing undo offer, for a delete or a caption apply alike, and a
   * serial number that is new every time an offer is raised — the banner's key,
   * and so its clock.
   */
  const [undoOffer, setUndoOffer] = useState<(UndoOffer & { serial: number }) | null>(
    null,
  );
  const undoSerial = useRef(0);
  const undoing = useRef(false);
  const dismissUndo = useCallback(() => setUndoOffer(null), []);

  const offerUndo = useCallback((offer: UndoOffer) => {
    undoSerial.current += 1;
    setUndoOffer({ ...offer, serial: undoSerial.current });
  }, []);

  async function undo() {
    // Once per offer: a second click on a caption Undo would find every photo
    // already put back and report them all as changed since.
    if (!undoOffer || undoing.current) return;
    const offer = undoOffer;

    undoing.current = true;
    try {
      try {
        await offer.perform();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Undo failed.');
        return;
      }
      // Only this offer. One raised while the request was out is still standing.
      setUndoOffer((current) => (current?.serial === offer.serial ? null : current));
    } finally {
      undoing.current = false;
    }
  }

  const [preview, setPreview] = useState<TrashPreview | null>(null);
  const cancelTrash = useCallback(() => setPreview(null), []);

  async function startTrash(query: SelectionQuery, from: string | null) {
    setError(null);
    try {
      setPreview({ result: await curationApi.previewTrash(query), from });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That could not be prepared.');
    }
  }

  async function confirmTrash() {
    if (!preview || !data) return;
    const { result, from } = preview;
    try {
      const outcome = await curationApi.confirmTrash(result);
      setPreview(null);

      // Before the patch, while the trashed photo still has neighbours.
      const next = from ? nextAfterDeleting(orderedIds, outcome.trashed, from) : null;

      setPatched(removePhotos(data, outcome.trashed));
      offerUndo({
        message: `${photoCount(outcome.count)} deleted.`,
        perform: async () => {
          try {
            await curationApi.restore(outcome.trashed);
          } catch (cause) {
            throw cause instanceof Error
              ? cause
              : new Error('Restore failed.', { cause });
          }
          // No patch: the restored photos are not in the response this page
          // holds, so a refetch is the honest answer, and the undo path is rare.
          countTrashAgain();
          refetch();
        },
      });

      if (from) {
        // A replace, so Back from the next photo does not land on the one just
        // trashed — which is a 404 now. It stays in whichever view the delete
        // was made from.
        const photoRoute = onRecent ? routes.recentPhoto : routes.photo;
        const listing = onRecent ? routes.recent : routes.home;
        navigate(next ? photoRoute(next) : listing(), { replace: true });
      }
      countTrashAgain();
      refetch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That could not be completed.');
      setPreview(null);
    }
  }

  async function saveEdit(photoId: string, edit: PhotoEdit): Promise<PublicPhoto> {
    setError(null);
    // Rejections travel to the form, which is where the message belongs.
    const { photo } = await curationApi.edit(photoId, edit);
    if (data) setPatched(upsertPhoto(data, photo));
    refetch();
    return photo;
  }

  function patchInPlace(photos: PublicPhoto[]) {
    if (photos.length === 0) return;
    // From the latest copy, not this render's: a dialog and a request stand
    // between the render that started a change and its reply.
    setPatched((current) => {
      const base = current ?? data;
      return base ? replacePhotosInPlace(base, photos) : current;
    });
  }

  return {
    timeline,
    data,
    index,
    orderedIds,
    refetch,
    setPatched,
    patchInPlace,
    error,
    setError,
    trashCount,
    countTrashAgain,
    preview,
    startTrash,
    confirmTrash,
    cancelTrash,
    saveEdit,
    undoOffer,
    offerUndo,
    dismissUndo,
    undo,
  };
}
