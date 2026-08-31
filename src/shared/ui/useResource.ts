/**
 * A small async-resource hook.
 *
 * The site has one kind of read — fetch some JSON for the current route — so
 * it needs a loading flag, a not-found state distinct from a failure, and
 * cancellation when the route changes. That is all this does.
 */

import { useEffect, useRef, useState } from 'react';

/** Thrown for any resource the API declines to serve. */
export class NotFoundError extends Error {
  constructor(message = 'Not found') {
    super(message);
    this.name = 'NotFoundError';
  }
}

export type Resource<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T; stale: boolean }
  | { status: 'not-found' }
  | { status: 'error'; message: string };

export interface ResourceOptions {
  /**
   * Keep showing the previous result while the next one loads, marking it
   * `stale`, instead of dropping back to `loading`.
   *
   * The lightbox needs this: without it, every previous/next step unmounts
   * the whole dialog for the duration of a request. That flashes the photo
   * away and — because the dialog owns the arrow-key handler — silently
   * swallows any keypress made during the gap, so holding an arrow key
   * advances one photo instead of several.
   */
  keepPreviousData?: boolean;
}

export function useResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
  options: ResourceOptions = {},
): Resource<T> {
  const [resource, setResource] = useState<Resource<T>>({ status: 'loading' });
  const previous = useRef<T | null>(null);

  const { keepPreviousData = false } = options;

  useEffect(() => {
    const controller = new AbortController();

    const retained = keepPreviousData ? previous.current : null;
    setResource(
      retained === null
        ? { status: 'loading' }
        : { status: 'ready', data: retained, stale: true },
    );

    load(controller.signal).then(
      (data) => {
        if (controller.signal.aborted) return;
        previous.current = data;
        setResource({ status: 'ready', data, stale: false });
      },
      (error: unknown) => {
        // An abort is a route change, not a failure; leave the state alone so
        // the next load's state is not overwritten by a stale error.
        if (controller.signal.aborted) return;
        previous.current = null;
        if (error instanceof NotFoundError) {
          setResource({ status: 'not-found' });
          return;
        }
        setResource({
          status: 'error',
          message: error instanceof Error ? error.message : 'Something went wrong.',
        });
      },
    );

    return () => controller.abort();
    // The caller supplies the dependency list that identifies this request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return resource;
}
