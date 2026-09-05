/** @vitest-environment happy-dom */

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ViewToggle } from '../../src/shared/ui/ViewToggle.tsx';

/**
 * The unseen notice, which replaced a dot: words rather than a mark, and to
 * the *right* of the link it qualifies, where it reads as a parenthetical on
 * it — so a screen reader meets the link first and then what qualifies it.
 */

const NOTICE = '(including new ones you haven’t seen)';

describe('the view toggle', () => {
  it('shows the notice after the Recently added link when something is unseen', () => {
    render(<ViewToggle current="library" unseen />);

    const notice = screen.getByText(NOTICE);
    const link = screen.getByRole('link', { name: 'Recently added' });
    // Node.DOCUMENT_POSITION_FOLLOWING: the notice comes after the link.
    expect(link.compareDocumentPosition(notice) & 4).toBeTruthy();
  });

  it('shows nothing when there is nothing unseen', () => {
    render(<ViewToggle current="library" unseen={false} />);
    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it('shows nothing on the recent view itself', () => {
    // `useUnseenRecent` already returns false there; this pins that the
    // component adds nothing of its own on the page that clears it.
    render(<ViewToggle current="recent" unseen={false} />);
    expect(screen.queryByText(NOTICE)).toBeNull();
  });
});
