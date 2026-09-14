import { Confirm, UndoBanner } from './Confirm.tsx';
import type { Library } from './library.ts';

/**
 * What both apps render below the page for the library they curate: the error
 * line, the trash confirmation, and the undo offer.
 *
 * Outside the listing and the photo view on purpose. An offer raised on the
 * timeline must survive walking over to the trash, and a delete can fail while
 * the photo view is covering the page.
 */
export function LibraryChrome({ library }: { library: Library }) {
  const { error, preview, undoOffer } = library;

  return (
    <>
      {/* Fixed at the top, above the photo view: a delete can fail while the
          photo view is covering the page, and the reason has to be visible. */}
      {error ? (
        <p className="admin-banner admin-error" role="alert">
          {error}
        </p>
      ) : null}

      {preview ? (
        <Confirm
          preview={preview.result}
          title="Delete photos?"
          description="will move to the trash, where they are kept for 30 days."
          confirmLabel="Delete"
          destructive
          onConfirm={() => void library.confirmTrash()}
          onCancel={library.cancelTrash}
        />
      ) : null}

      {undoOffer ? (
        /*
         * Five seconds from the moment it appears, and nothing else retires
         * it: not arrowing, not closing the photo view, not clicking a
         * heading. Advancing after a delete is itself a navigation, so a rule
         * that retired the offer on navigation would withdraw it before it
         * could be read.
         *
         * A later offer of any kind replaces it. Keyed by a serial number
         * raised with each offer, so a second offer inside those five seconds
         * gets a fresh clock — even a second apply to the very same photos,
         * which a key built from the photo IDs would not tell apart.
         */
        <UndoBanner
          key={undoOffer.serial}
          message={undoOffer.message}
          onUndo={() => void library.undo()}
          onDismiss={library.dismissUndo}
        />
      ) : null}
    </>
  );
}
