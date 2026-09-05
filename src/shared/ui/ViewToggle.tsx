import { Link } from './Link.tsx';
import { routes } from './api.ts';

interface ViewToggleProps {
  /**
   * Which of the two views the reader is in, or `null` when neither — the
   * admin's trash page, where both labels are links.
   */
  current: 'library' | 'recent' | null;
  /** Raise the marker: something has arrived that this browser has not seen. */
  unseen: boolean;
}

/**
 * The two ways into the library, beside the site title.
 *
 * Both labels are always visible and the current one is plain text rather than
 * a disabled link: a control that can do nothing is not shown as a control
 * (decisions.md #36), and the pair has to read as a pair whichever half you
 * are standing in.
 *
 * The marker is a dot, not a count. A total would sit near the same number
 * forever, because the recent set has a floor of 50; an unseen count needs a
 * per-device diff that goes wrong after a delete, for a number nobody acts on
 * differently than a dot.
 */
export function ViewToggle({ current, unseen }: ViewToggleProps) {
  return (
    <>
      {current === 'library' ? (
        <span className="view-toggle__current" aria-current="page">
          All photos
        </span>
      ) : (
        <Link to={routes.home()}>All photos</Link>
      )}

      {current === 'recent' ? (
        <span className="view-toggle__current" aria-current="page">
          Recently added
        </span>
      ) : (
        <Link to={routes.recent()}>
          Recently added
          {unseen ? (
            <>
              <span className="view-toggle__marker" aria-hidden="true" />
              {/* The dot is decoration; this is what a screen reader hears. */}
              <span className="visually-hidden"> (new photographs)</span>
            </>
          ) : null}
        </Link>
      )}
    </>
  );
}
