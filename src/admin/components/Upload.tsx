import { useCallback, useEffect, useRef, useState } from 'react';
import { ACCEPTED_EXTENSIONS } from '../../shared/constants.ts';
import { hasAcceptedExtension } from '../../pipeline/validate.ts';
import { processFile } from '../../pipeline/index.ts';
import { UploadQueue, summarize } from '../upload/queue.ts';
import type { QueueItem, QueueSnapshot } from '../upload/queue.ts';
import { adminApi, routes } from '../api.ts';
import { Link } from '../../shared/ui/Link.tsx';

/**
 * PUT one artifact straight to R2 with its presigned URL.
 *
 * This is the only request in the app that leaves the site's origin. It is a
 * cors-mode fetch, so the browser sends a real Origin header even under
 * Referrer-Policy: no-referrer — which is what the bucket's CORS rule keys on.
 */
async function uploadArtifact(
  url: string,
  artifact: { bytes: Uint8Array; contentType: string },
): Promise<void> {
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': artifact.contentType },
    body: artifact.bytes as BodyInit,
  });
  if (!response.ok) {
    throw new Error(`Upload failed (${response.status}).`);
  }
}

function createQueue(): UploadQueue {
  return new UploadQueue({
    processFile: (file, options) =>
      processFile(file, {
        // Encoding dominates; report progress as each artifact lands.
        onArtifact: () => options.onProgress(0.5),
      }),
    beginBatch: () => adminApi.beginBatch(),
    prepare: (hash, filename) => adminApi.prepare(hash, filename),
    uploadArtifact,
    commit: (body) => adminApi.commit(body),
  });
}

const STATE_LABELS: Record<QueueItem['state'], string> = {
  queued: 'Waiting',
  processing: 'Processing',
  uploading: 'Uploading',
  committing: 'Finishing',
  done: 'Added',
  skipped: 'Already uploaded – skipped',
  failed: 'Failed',
};

interface UploadPanelProps {
  /** Called after a batch settles, so the grid can pick up new photos. */
  onBatchComplete: () => void;
  /** Larger and more prominent when the library is empty. */
  emphasized: boolean;
}

export function UploadPanel({ onBatchComplete, emphasized }: UploadPanelProps) {
  // Lazy state, not a ref: the queue is created once, and reading a ref
  // during render is unsafe.
  const [queue] = useState(createQueue);
  const [snapshot, setSnapshot] = useState<QueueSnapshot>(() => queue.snapshot());
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const wasActive = useRef(false);

  useEffect(() => queue.subscribe(setSnapshot), [queue]);

  // Refresh the grid once, on the edge from busy to idle, rather than on
  // every state change.
  useEffect(() => {
    if (wasActive.current && !snapshot.active) onBatchComplete();
    wasActive.current = snapshot.active;
  }, [snapshot.active, onBatchComplete]);

  const addFiles = useCallback(
    (files: FileList | null) => {
      if (!files || files.length === 0) return;
      // Filter by extension here so a stray .DS_Store or .mov from a dropped
      // folder does not fill the queue with rejections.
      const accepted = [...files].filter((file) => hasAcceptedExtension(file.name));
      if (accepted.length > 0) void queue.add(accepted);
    },
    [queue],
  );

  return (
    <section className={`upload ${emphasized ? 'upload--empty-library' : ''}`}>
      <div
        className={`drop-target ${dragging ? 'drop-target--active' : ''}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          addFiles(event.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            inputRef.current?.click();
          }
        }}
        role="button"
        tabIndex={0}
        aria-label="Add photos: drop files here, or press to choose them"
      >
        <p className="drop-target__headline">Drop photos here</p>
        <p className="drop-target__hint">
          or press to choose them. JPEG, PNG, and HEIC.
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPTED_EXTENSIONS.join(',')}
          className="drop-target__input"
          onChange={(event) => {
            addFiles(event.target.files);
            // Allow re-selecting the same files, which is the documented way
            // to resume an interrupted batch.
            event.target.value = '';
          }}
        />
      </div>

      {snapshot.items.length > 0 ? (
        <div className="queue">
          <div className="queue__summary" aria-live="polite">
            {snapshot.active
              ? `Working through ${snapshot.items.length} file${
                  snapshot.items.length === 1 ? '' : 's'
                }…`
              : summarize(snapshot)}
          </div>

          <ul className="queue__list">
            {snapshot.items.map((item) => (
              <li key={item.id} className={`queue__item queue__item--${item.state}`}>
                <span className="queue__name">{item.file.name}</span>
                <span className="queue__state">{STATE_LABELS[item.state]}</span>

                {item.state === 'skipped' && item.existingPhotoId ? (
                  <Link to={routes.photo(item.existingPhotoId)} className="queue__link">
                    View the existing photo
                  </Link>
                ) : null}

                {item.state === 'failed' ? (
                  <>
                    <span className="queue__error">{item.error}</span>
                    <button type="button" onClick={() => void queue.retry(item.id)}>
                      Retry
                    </button>
                  </>
                ) : null}

                {item.state !== 'done' &&
                item.state !== 'failed' &&
                item.state !== 'skipped' ? (
                  <progress className="queue__progress" value={item.progress} max={1} />
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
