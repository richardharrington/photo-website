import { describe, expect, it } from 'vitest';
import { nextAfterDeleting } from '../../src/admin/advance.ts';

/**
 * Where the photo view lands after a delete.
 *
 * The end-to-end suite covers the ordinary case against the fixture library,
 * but the two ends of it cannot be: reaching them means deleting the last
 * photograph in a fixture two browser projects share, or emptying it
 * altogether. They are the cases that decide whether triage stops working at
 * the bottom of the library, so they are pinned here instead.
 */

const ids = ['a', 'b', 'c', 'd'];

describe('nextAfterDeleting', () => {
  it('goes to the next photo in library order', () => {
    expect(nextAfterDeleting(ids, ['b'], 'b')).toBe('c');
  });

  it('steps back when the deleted photo was the last one', () => {
    expect(nextAfterDeleting(ids, ['d'], 'd')).toBe('c');
  });

  it('has nowhere to go when nothing is left', () => {
    expect(nextAfterDeleting(['a'], ['a'], 'a')).toBeNull();
  });

  it('skips photos deleted in the same action', () => {
    // A bulk delete can take the neighbour along with the open photo.
    expect(nextAfterDeleting(ids, ['b', 'c'], 'b')).toBe('d');
    expect(nextAfterDeleting(ids, ['b', 'c', 'd'], 'b')).toBe('a');
  });

  it('gives up on a photo that is not in the list', () => {
    expect(nextAfterDeleting(ids, ['z'], 'z')).toBeNull();
  });
});
