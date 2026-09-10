import type { ReactNode } from 'react';
import { useCuration } from './curation.ts';

/**
 * A listing's one line teaching the gesture.
 *
 * Click-to-select and double-click-to-open is what every file manager already
 * teaches, but a tile cannot show it and the tooltip that says so does nothing
 * on a touchscreen — where the gesture is a long-press, which is even less
 * discoverable. So each selecting listing says it in prose, in its own voice.
 *
 * Decisions.md #78. Rendered only for a curation that selects, which is how it
 * stays out of the viewer entirely and off the upload panel's tiles, whose
 * single click still opens.
 */
export function SelectionHelp({ children }: { children: ReactNode }) {
  const curation = useCuration();
  if (!curation?.can.select) return null;
  return <p className="selection-help">{children}</p>;
}
