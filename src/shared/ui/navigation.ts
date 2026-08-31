/**
 * Minimal History-API navigation, shared by both apps.
 *
 * A routing library would be a reasonable choice, but the whole route table
 * here is six shapes deep and the app must ship no third-party browser
 * resources it does not need. This is the entire router.
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';

type Listener = () => void;

const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', listener);
  };
}

function currentPath(): string {
  return window.location.pathname;
}

/** Push a new entry and re-render. */
export function navigate(to: string, options: { replace?: boolean } = {}): void {
  if (to === currentPath()) return;
  if (options.replace) window.history.replaceState(null, '', to);
  else window.history.pushState(null, '', to);
  notify();
}

export function useLocationPath(): string {
  return useSyncExternalStore(subscribe, currentPath, () => '/');
}

/**
 * Props for an internal link: a real `href` so the link is copyable,
 * middle-clickable, and openable in a new tab, with a click handler that keeps
 * ordinary navigation client-side.
 */
export function useLinkProps(to: string) {
  const onClick = useCallback(
    (event: React.MouseEvent<HTMLAnchorElement>) => {
      // Let the browser handle anything that is not a plain left click.
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      event.preventDefault();
      navigate(to);
    },
    [to],
  );

  return { href: to, onClick };
}

/** Restore the window to the top when the route changes. */
export function useScrollToTopOnChange(key: string): void {
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [key]);
}
