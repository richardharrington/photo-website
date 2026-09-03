import { Link } from './Link.tsx';
import { routes } from './api.ts';

/**
 * Shown while a request is in flight. `aria-busy` announces the wait without
 * a spinner competing with the photos for attention.
 */
export function Loading() {
  return (
    <p className="state state--loading" aria-busy="true">
      Loading…
    </p>
  );
}

/**
 * The single 404 for unknown groups, unknown photos, and trashed photos
 * alike. It says nothing about which of those it was.
 */
export function NotFound() {
  return (
    <div className="state">
      <h1>Not found</h1>
      <p>There is nothing at this address.</p>
      <p>
        <Link to={routes.home()}>Go to the start</Link>
      </p>
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div className="state" role="alert">
      <h1>Something went wrong</h1>
      <p>{message}</p>
    </div>
  );
}

export function Empty({ children = 'No photos here yet.' }: { children?: string }) {
  return <p className="state state--empty">{children}</p>;
}
