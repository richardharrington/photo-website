import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useResource } from '../../shared/ui/useResource.ts';
import { Layout } from '../../shared/ui/Layout.tsx';
import { ErrorState, Loading } from '../../shared/ui/States.tsx';
import { Link } from '../../shared/ui/Link.tsx';
import { INBOX_SMALL_PART_BYTES } from '../../shared/constants.ts';
import { MAX_CAPTION_LENGTH, normalizeCaption } from '../../shared/validation.ts';
import { generateConfirmationToken } from '../../shared/ids.ts';
import { adminApi, routes } from '../api.ts';
import type { InboxListing, InboxPart, InboxSubmission } from '../api.ts';
import { createQueue } from '../upload/create.ts';
import { isInFlight } from '../upload/queue.ts';
import type { QueueItem, QueueSnapshot, UploadQueue } from '../upload/queue.ts';
import { orientationTransform, readEmbeddedThumbnail } from '../inbox/thumbnail.ts';
import type { PartPreview } from '../inbox/thumbnail.ts';
import { decodePreview } from '../../pipeline/preview.ts';
import { ConfirmDialog } from './Confirm.tsx';

/** A stable empty listing, so a render with no data is not a new array. */
const NO_SUBMISSIONS: readonly InboxSubmission[] = [];

/**
 * `receivedAt` is a genuine instant, unlike a capture time, so it is shown in
 * the administrator's own zone — when the mail arrived by their clock.
 */
function receivedAtLabel(receivedAt: string): string {
  return new Date(receivedAt).toLocaleString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function minutesAgo(claimedAt: string): number {
  return Math.max(0, Math.round((Date.now() - Date.parse(claimedAt)) / 60_000));
}

/**
 * Emailed photographs waiting to be looked at.
 *
 * Nothing a family member sends is shown to anyone until an administrator has
 * been through it here: they see who sent what, correct the caption the subject
 * line proposed, untick anything that is not a photograph, and press Add. Only
 * then does anything enter the library — through the exact pipeline a dropped
 * file goes through, in this browser, one file at a time.
 *
 * No part is decoded to render this page. The tiles are the thumbnails cameras
 * already embed, fetched with Range requests; see `inbox/thumbnail.ts`.
 */
export function InboxPage({
  nav,
  onChanged,
}: {
  nav: ReactNode;
  /** The header's Inbox count is the app's, and every action here changes it. */
  onChanged: () => void;
}) {
  const [reloadKey, setReloadKey] = useState(0);

  const resource = useResource<InboxListing>(
    (signal) => adminApi.inbox(signal),
    [reloadKey],
  );

  const submissions =
    resource.status === 'ready' ? resource.data.submissions : NO_SUBMISSIONS;

  const reload = useCallback(() => {
    setReloadKey((key) => key + 1);
    onChanged();
  }, [onChanged]);

  if (resource.status === 'loading') {
    return (
      <Layout nav={nav}>
        <Loading />
      </Layout>
    );
  }
  if (resource.status === 'error' || resource.status === 'not-found') {
    return (
      <Layout nav={nav}>
        <ErrorState
          message={
            resource.status === 'error'
              ? resource.message
              : 'The inbox could not be read.'
          }
        />
      </Layout>
    );
  }

  return (
    <Layout nav={nav}>
      <p className="inbox__intro">
        Photographs emailed in by the people you have switched on under Emails. Nothing
        here is on the site yet. Correct the caption, untick anything that is not a
        photograph, and press Add; they then go in exactly as a dropped file does.
      </p>

      {submissions.length === 0 ? (
        <p className="state state--empty">Nothing is waiting.</p>
      ) : (
        submissions.map((submission) => (
          <SubmissionCard
            key={submission.id}
            submission={submission}
            claimTtlMinutes={resource.data.claimTtlMinutes}
            onChanged={reload}
          />
        ))
      )}
    </Layout>
  );
}

/** What one card is doing. */
type CardPhase = 'idle' | 'adding' | 'settled';

interface CardProps {
  submission: InboxSubmission;
  claimTtlMinutes: number;
  onChanged: () => void;
}

function SubmissionCard({ submission, claimTtlMinutes, onChanged }: CardProps) {
  const { id, parts } = submission;

  /**
   * Which parts go in.
   *
   * Everything starts ticked except a part under the small-part threshold — a
   * signature logo or an inline emoji, which arrives as a part because only the
   * bytes are believed and a logo is a perfectly good PNG. A photograph never
   * starts unticked, and every tick can be flipped.
   */
  const [ticked, setTicked] = useState<ReadonlySet<number>>(
    () =>
      new Set(
        parts
          .filter((part) => part.bytes >= INBOX_SMALL_PART_BYTES)
          .map((part) => part.index),
      ),
  );
  const [caption, setCaption] = useState(submission.proposedCaption ?? '');
  const [phase, setPhase] = useState<CardPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [held, setHeld] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [snapshot, setSnapshot] = useState<QueueSnapshot | null>(null);

  /**
   * The work this tab has started: the claim it holds, the queue running it,
   * and the ticked parts in the order they were handed over — which is how a
   * queue item is matched back to the part it came from.
   *
   * State rather than a ref because the render reads all three: the card's
   * controls turn on whether this tab is the one working, each row's outcome is
   * looked up through the order, and a Retry needs the queue.
   */
  const [mine, setMine] = useState<{
    token: string;
    order: InboxPart[];
    queue: UploadQueue;
  } | null>(null);

  const previews = usePartPreviews(submission);
  const decoded = useDecodedPreviews(submission.id);

  const captionError = useMemo(() => {
    const normalized = normalizeCaption(caption);
    return normalized !== null && normalized.length > MAX_CAPTION_LENGTH
      ? `Caption must be ${MAX_CAPTION_LENGTH} characters or fewer.`
      : null;
  }, [caption]);

  const chosen = parts.filter((part) => ticked.has(part.index));

  /**
   * Somebody else is on this one.
   *
   * A live claim from another tab disables the card entirely; an expired one
   * offers Take over, because a claim that old is a tab that has gone.
   */
  const claimedElsewhere = mine === null && submission.claimedAt !== null;
  const canTakeOver = claimedElsewhere && submission.claimExpired;

  /**
   * Remove the submission: its raw parts and its record.
   *
   * Called once every ticked part has reached an outcome. A part that *failed*
   * is deliberately not swept up in that — a failure has a Retry beside it, and
   * retrying is impossible once the bytes are deleted — so a card with failures
   * waits for the administrator to press Finish and a card without them
   * finishes itself.
   *
   * A tab that dies before either simply leaves the claim to expire: the
   * submission reappears in full, and re-adding it finds its already-committed
   * parts as duplicates, which is the right answer.
   */
  async function resolve(token: string, settled: QueueSnapshot) {
    const photoIds = settled.items
      .map((item) => item.photoId)
      .filter((photoId): photoId is string => photoId !== undefined);
    try {
      await adminApi.resolveSubmission(id, token, photoIds);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That could not be finished.');
      return;
    }
    setMine(null);
    onChanged();
  }

  async function add() {
    setError(null);
    const token = generateConfirmationToken();

    let claim;
    try {
      claim = await adminApi.claimSubmission(id, token);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That could not be started.');
      return;
    }

    if (claim.status === 'held') {
      setHeld(claim.claimedAt);
      onChanged();
      return;
    }
    if (claim.status === 'conflict') {
      // Someone wrote between our read and our write. Reloading shows whatever
      // is actually there now, which is the only honest thing to show.
      onChanged();
      return;
    }

    const queue = createQueue({
      // The one dependency the Inbox overrides: its commits name the
      // submission and the claim, and the server resolves the sender from the
      // stored record. Everything else — the pipeline, the duplicate check,
      // the serial discipline — is the drop target's, unchanged.
      commit: (body) =>
        adminApi.commit({ ...body, submissionId: id, claimToken: token }),
    });
    queue.subscribe(setSnapshot);

    setMine({ token, order: chosen, queue });
    setPhase('adding');

    let files: File[];
    try {
      files = await Promise.all(chosen.map((part) => fetchPart(id, part)));
    } catch (cause) {
      setPhase('idle');
      setMine(null);
      setError(
        cause instanceof Error ? cause.message : 'The photos could not be fetched.',
      );
      return;
    }

    // One email is one batch: the whole set goes in at once, and the caption
    // travels into each file's own commit rather than as N later edits.
    await queue.add(files, normalizeCaption(caption));

    const settled = queue.snapshot();
    setPhase('settled');
    if (settled.counts.failed === 0) await resolve(token, settled);
  }

  const failures = snapshot?.counts.failed ?? 0;

  async function retry(itemId: string) {
    if (!mine) return;
    await mine.queue.retry(itemId);
    const settled = mine.queue.snapshot();
    if (settled.counts.failed === 0) await resolve(mine.token, settled);
  }

  async function discard() {
    setConfirmDiscard(false);
    setError(null);
    const token = mine?.token ?? generateConfirmationToken();
    try {
      const claim = await adminApi.claimSubmission(id, token);
      if (claim.status === 'held') {
        setHeld(claim.claimedAt);
        onChanged();
        return;
      }
      if (claim.status === 'conflict') {
        onChanged();
        return;
      }
      await adminApi.discardSubmission(id, token);
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That could not be discarded.');
    }
  }

  const byPart = new Map<number, QueueItem>();
  if (snapshot && mine) {
    for (const item of snapshot.items) {
      const part = mine.order[item.selectionIndex];
      if (part) byPart.set(part.index, item);
    }
  }

  const busy = phase === 'adding';

  return (
    <section className="inbox__card">
      <h2 className="inbox__from">
        <span>{submission.from ?? 'An address that has since been removed'}</span>
        <span className="inbox__meta">
          {receivedAtLabel(submission.receivedAt)} · {parts.length} file
          {parts.length === 1 ? '' : 's'}
        </span>
      </h2>

      {submission.subject ? (
        <p className="inbox__subject">Subject: {submission.subject}</p>
      ) : null}

      {/* Only until the reload that follows lands and the card's own
          `claimedElsewhere` says the same thing from the server's answer. */}
      {held && !claimedElsewhere ? (
        <p className="inbox__claimed" role="status">
          Being added in another tab, started {minutesAgo(held)} minutes ago.
        </p>
      ) : null}

      {error ? (
        <p className="admin-error" role="alert">
          {error}
        </p>
      ) : null}

      {claimedElsewhere ? (
        <p className="inbox__claimed" role="status">
          Being added in another tab
          {submission.claimedAt
            ? `, started ${minutesAgo(submission.claimedAt)} minutes ago`
            : ''}
          .
        </p>
      ) : null}

      <label className="inbox__caption">
        <span>Caption</span>
        <input
          type="text"
          value={caption}
          disabled={busy || claimedElsewhere}
          placeholder="No caption"
          onChange={(event) => setCaption(event.target.value)}
        />
      </label>
      {captionError ? (
        <p className="admin-error" role="alert">
          {captionError}
        </p>
      ) : null}

      <ul className="inbox__parts">
        {parts.map((part) => (
          <PartRow
            key={part.index}
            part={part}
            preview={previews.get(part.index) ?? null}
            decoded={decoded.state(part.index)}
            onShow={() => decoded.show(part)}
            checked={ticked.has(part.index)}
            disabled={busy || phase === 'settled' || claimedElsewhere}
            item={byPart.get(part.index)}
            onRetry={retry}
            onToggle={() =>
              setTicked((current) => {
                const next = new Set(current);
                if (next.has(part.index)) next.delete(part.index);
                else next.add(part.index);
                return next;
              })
            }
          />
        ))}
      </ul>

      {/* Only worth offering when there is more than one picture to uncover;
          for a single part the row's own button is right there. Each decode
          still runs on its own, one at a time — this only saves the clicks. */}
      {phase === 'idle' && decoded.hidden(parts).length > 1 ? (
        <p className="inbox__hint">
          <button
            type="button"
            disabled={decoded.working}
            onClick={() => decoded.showAll(parts)}
          >
            {decoded.working
              ? 'Decoding…'
              : `Show all ${decoded.hidden(parts).length} photos`}
          </button>{' '}
          Decoding is the slow part of adding a photograph, so it happens only when you
          ask — one file at a time.
        </p>
      ) : null}

      <div className="inbox__actions">
        {phase === 'settled' && failures > 0 ? (
          <>
            <span className="admin-error">
              {failures} could not be added. Retry above, or finish and delete the rest.
            </span>
            <button
              type="button"
              onClick={() => void (mine && snapshot && resolve(mine.token, snapshot))}
            >
              Finish
            </button>
          </>
        ) : phase === 'idle' ? (
          <>
            {canTakeOver ? (
              <button type="button" onClick={() => void add()}>
                Take over
              </button>
            ) : null}
            <button
              type="button"
              className="admin-danger"
              disabled={claimedElsewhere && !canTakeOver}
              onClick={() => setConfirmDiscard(true)}
            >
              Discard
            </button>
            <button
              type="button"
              disabled={
                chosen.length === 0 ||
                captionError !== null ||
                (claimedElsewhere && !canTakeOver)
              }
              onClick={() => void add()}
            >
              Add {chosen.length} photo{chosen.length === 1 ? '' : 's'}
            </button>
          </>
        ) : null}
      </div>

      {confirmDiscard ? (
        <ConfirmDialog
          title="Discard these photos?"
          confirmLabel="Discard"
          destructive
          onConfirm={() => void discard()}
          onCancel={() => setConfirmDiscard(false)}
        >
          Discard {parts.length} file{parts.length === 1 ? '' : 's'} from{' '}
          <strong>{submission.from ?? 'this sender'}</strong>? They will be deleted and
          cannot be recovered — the trash is for photographs, and these never were.
        </ConfirmDialog>
      ) : null}

      <p className="inbox__hint">
        A claim on a message lasts {claimTtlMinutes} minutes; after that another tab can
        take it over.
      </p>
    </section>
  );
}

/**
 * The tile and label for one part, and its outcome once Add has run.
 *
 * The tile is one of three things, in this order of preference: the thumbnail
 * the camera embedded, which cost a Range request; the picture an
 * administrator asked to have decoded; or the neutral tile, which carries the
 * filename and the size and is very often enough — a 3 MB file is a photograph
 * and a 4 KB file is a logo.
 */
function PartRow({
  part,
  preview,
  decoded,
  onShow,
  checked,
  disabled,
  item,
  onRetry,
  onToggle,
}: {
  part: InboxPart;
  preview: PartPreview | null;
  decoded: DecodeState;
  onShow: () => void;
  checked: boolean;
  disabled: boolean;
  item: QueueItem | undefined;
  onRetry: (itemId: string) => void;
  onToggle: () => void;
}) {
  // The EXIF thumbnail is stored unrotated and is rotated here by its tag; a
  // decoded preview came out of the pipeline upright and needs no transform.
  const transform = preview ? orientationTransform(preview.orientation) : null;
  const shown = decoded.status === 'shown' ? decoded.url : (preview?.url ?? null);

  return (
    <li className="inbox__part">
      <label>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={onToggle}
        />
        {shown ? (
          <img
            className={
              decoded.status === 'shown'
                ? 'inbox__thumb inbox__thumb--decoded'
                : 'inbox__thumb'
            }
            src={shown}
            alt=""
            style={decoded.status === 'shown' || !transform ? undefined : { transform }}
          />
        ) : (
          // No embedded thumbnail: every HEIC, and PNGs, screenshots, images
          // saved from the web, and signature logos. The absence is itself a
          // signal, and Show is there when it is not enough.
          <span className="inbox__thumb inbox__thumb--none" aria-hidden="true" />
        )}
        <span className="inbox__filename">{part.filename ?? 'Unnamed'}</span>
        <span className="inbox__bytes">{fileSize(part.bytes)}</span>
      </label>

      {shown === null || decoded.status !== 'idle' ? (
        <span className="inbox__show">
          {decoded.status === 'idle' ? (
            <button type="button" onClick={onShow}>
              Show
            </button>
          ) : decoded.status === 'queued' ? (
            <span>Waiting to decode…</span>
          ) : decoded.status === 'decoding' ? (
            <span>Decoding…</span>
          ) : decoded.status === 'failed' ? (
            <>
              <span className="admin-error">{decoded.message}</span>
              <button type="button" onClick={onShow}>
                Try again
              </button>
            </>
          ) : null}
        </span>
      ) : null}

      {item ? <PartOutcome item={item} onRetry={onRetry} /> : null}
    </li>
  );
}

/** The upload panel's own vocabulary, on an Inbox row. */
const STATE_LABELS: Record<QueueItem['state'], string> = {
  queued: 'Waiting',
  processing: 'Processing',
  uploading: 'Uploading',
  committing: 'Finishing',
  done: 'Added',
  skipped: 'Already in the library',
  failed: 'Rejected',
};

function PartOutcome({
  item,
  onRetry,
}: {
  item: QueueItem;
  onRetry: (itemId: string) => void;
}) {
  return (
    <span className="inbox__outcome">
      <span className={item.state === 'failed' ? 'admin-error' : undefined}>
        {item.state === 'skipped' && item.existingPhotoTrashed
          ? 'Already in the library, now in the trash'
          : STATE_LABELS[item.state]}
      </span>
      {isInFlight(item.state) ? (
        <progress className="upload__progress" value={item.progress} max={1} />
      ) : null}
      {item.state === 'skipped' && item.existingPhotoId ? (
        // A trashed photo has no `/photo/<id>` address — that route is a 404
        // by design — so the only honest link is to the trash.
        item.existingPhotoTrashed ? (
          <Link to={routes.trash()}>Find it in the trash</Link>
        ) : (
          <Link to={routes.photo(item.existingPhotoId)}>View the existing photo</Link>
        )
      ) : null}
      {item.state === 'failed' ? (
        <>
          {item.error ? <span className="admin-error">{item.error}</span> : null}
          {/* The raw part is still in R2 — a failed part is why the whole
              submission is not removed yet — so this can genuinely be tried
              again rather than only looking as though it can. */}
          <button type="button" onClick={() => onRetry(item.id)}>
            Retry
          </button>
        </>
      ) : null}
    </span>
  );
}

/** What the Show control on one row is doing. */
type DecodeState =
  | { status: 'idle' }
  | { status: 'queued' }
  | { status: 'decoding' }
  | { status: 'shown'; url: string }
  | { status: 'failed'; message: string };

const IDLE: DecodeState = { status: 'idle' };

/**
 * Decoding a part on request, one at a time, and remembering the result.
 *
 * This is the answer to the limit `usePartPreviews` runs into: a HEIC has no
 * EXIF thumbnail, so the only way to see the picture is to decode it — and a
 * decode is the expensive, memory-risky thing the whole page is arranged to
 * avoid doing unasked (decisions.md #84). So it happens only when an
 * administrator asks, and `decodePreview` keeps every such decode behind the
 * last one however many are asked for at once.
 *
 * Nothing decoded here is stored or uploaded. It is a picture to look at while
 * deciding, thrown away when the card goes.
 */
function useDecodedPreviews(submissionId: string) {
  const [states, setStates] = useState<Record<number, DecodeState>>({});

  // Object URLs are document-lifetime references, so the card has to release
  // them itself. Held in a ref because the cleanup must see every URL ever
  // created, not the ones a particular render closed over.
  const urls = useRef<string[]>([]);
  useEffect(() => {
    const created = urls.current;
    return () => {
      for (const url of created) URL.revokeObjectURL(url);
      created.length = 0;
    };
  }, [submissionId]);

  const show = useCallback(
    async (part: InboxPart) => {
      setStates((current) => {
        const state = current[part.index]?.status;
        // Already showing, or already on its way: asking twice is a no-op.
        if (state === 'shown' || state === 'queued' || state === 'decoding') {
          return current;
        }
        return { ...current, [part.index]: { status: 'queued' } };
      });

      try {
        const file = await fetchPart(submissionId, part);
        setStates((current) => ({ ...current, [part.index]: { status: 'decoding' } }));

        const outcome = await decodePreview(file);
        if (!outcome.ok) {
          // A rejection is an answer about this file — too large, too many
          // pixels — not a failure of the page, and it says what it is.
          setStates((current) => ({
            ...current,
            [part.index]: { status: 'failed', message: outcome.message },
          }));
          return;
        }

        urls.current.push(outcome.preview.url);
        setStates((current) => ({
          ...current,
          [part.index]: { status: 'shown', url: outcome.preview.url },
        }));
      } catch (cause) {
        setStates((current) => ({
          ...current,
          [part.index]: {
            status: 'failed',
            message:
              cause instanceof Error ? cause.message : 'That could not be decoded.',
          },
        }));
      }
    },
    [submissionId],
  );

  /** Parts with nothing to look at yet, which is what Show all covers. */
  const hidden = useCallback(
    (parts: readonly InboxPart[]) =>
      parts.filter((part) => (states[part.index]?.status ?? 'idle') === 'idle'),
    [states],
  );

  return {
    state: (index: number): DecodeState => states[index] ?? IDLE,
    show,
    hidden,
    /** True while anything on this card is queued or decoding. */
    working: Object.values(states).some(
      (state) => state.status === 'queued' || state.status === 'decoding',
    ),
    showAll: (parts: readonly InboxPart[]) => {
      // Every one is started at once and `decodePreview` serialises them, so
      // the rows show a queue forming rather than six silent buttons.
      for (const part of hidden(parts)) void show(part);
    },
  };
}

/**
 * Every part's embedded thumbnail, fetched concurrently.
 *
 * Concurrent because they are tiny Range requests rather than the serial
 * pipeline; the whole point is that a card of six photographs renders at once
 * without decoding any of them.
 */
function usePartPreviews(submission: InboxSubmission): Map<number, PartPreview> {
  const [previews, setPreviews] = useState<Map<number, PartPreview>>(() => new Map());

  useEffect(() => {
    const controller = new AbortController();
    const created: string[] = [];
    let live = true;

    void Promise.all(
      submission.parts.map(async (part) => {
        const link = await adminApi.inboxPartUrl(submission.id, part.index);
        const preview = await readEmbeddedThumbnail(link.url, controller.signal);
        if (!live) {
          if (preview.url) URL.revokeObjectURL(preview.url);
          return;
        }
        if (preview.url) created.push(preview.url);
        setPreviews((current) => new Map(current).set(part.index, preview));
      }),
      // A card whose previews cannot be fetched still lists its parts by name
      // and size, which is enough to decide with.
    ).catch(() => undefined);

    return () => {
      live = false;
      controller.abort();
      // An object URL is a document-lifetime reference; dropping the map is
      // not enough to release the bytes behind it.
      for (const url of created) URL.revokeObjectURL(url);
    };
    // The id is the whole dependency: a submission's parts never change once
    // it is stored — only its claim does — so a listing refetch must not
    // re-run this, revoke the URLs the map is still rendering, and refetch
    // every thumbnail.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submission.id]);

  return previews;
}

/**
 * One raw part, as a `File` the pipeline will accept.
 *
 * The name matters: `downloadFilenameFor` and the filename-date fallback both
 * read it. When the sender's client stripped EXIF the photograph lands in
 * Undated with `timestampSource` of `filename` or `none`, which is correct and
 * which this page does not try to fix — the edit form is for that.
 */
async function fetchPart(submissionId: string, part: InboxPart): Promise<File> {
  const link = await adminApi.inboxPartUrl(submissionId, part.index);
  const response = await fetch(link.url);
  if (!response.ok) {
    throw new Error(`${part.filename ?? 'A photo'} could not be fetched.`);
  }
  const blob = await response.blob();
  return new File([blob], part.filename ?? 'photo', { type: link.contentType });
}
