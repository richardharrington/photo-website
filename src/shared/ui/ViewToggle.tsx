import { Link } from './Link.tsx';
import { routes } from './api.ts';

interface ViewToggleProps {
  /**
   * Which of the two views the reader is in, or `null` when neither — the
   * admin's trash page, where both labels are links.
   */
  current: 'library' | 'recent' | null;
  /** Raise the notice: something has arrived that this browser has not seen. */
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
 * The unseen marker is a notice, not a count. A count needs a per-device diff
 * that goes wrong after a delete, for a number nobody acts on differently than
 * a notice. It reads as words rather than the dot it once was, because a dot
 * says *that* something is new and nothing about *what* (decisions.md #65).
 *
 * It sits after the Recently added element and reads as a parenthetical on it
 * — All photos · Recently added · (including new ones you haven't seen) — so
 * a screen reader meets the link first and then what qualifies it, which is
 * the order the sentence is written in. It is not itself a link: it is beside
 * the one that acts on it, and a control that duplicates its neighbour is one
 * more thing to understand. It never appears while the reader is standing in
 * the recent view, so it only ever qualifies a link, never plain text.
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
        <Link to={routes.recent()}>Recently added</Link>
      )}

      {/* Sentence case here, uppercase in CSS: some screen readers spell an
          all-caps string out letter by letter, and this exists to be
          understood. */}
      {unseen ? (
        <span className="view-toggle__notice">
          (including new ones you haven’t seen)
        </span>
      ) : null}
    </>
  );
}
