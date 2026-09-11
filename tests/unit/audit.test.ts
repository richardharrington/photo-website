import { describe, expect, it } from 'vitest';
import { makeAuditEvent } from '../../src/shared/audit.ts';

describe('makeAuditEvent', () => {
  const at = '2026-09-11T10:00:00.000Z';

  it('carries per-photo caption changes when given', () => {
    const changes = [
      { photoId: 'a'.repeat(32), before: null, after: 'Beach' },
      { photoId: 'b'.repeat(32), before: 'Low tide', after: 'Beach' },
    ];
    const event = makeAuditEvent('caption-change', ['a'.repeat(32), 'b'.repeat(32)], {
      at,
      id: 'audit1',
      changes,
      note: 'undo',
    });

    expect(event).toEqual({
      id: 'audit1',
      at,
      action: 'caption-change',
      photoIds: ['a'.repeat(32), 'b'.repeat(32)],
      via: 'admin-api',
      changes,
      note: 'undo',
    });
    // A copy: the event is written after the request returns, and must not
    // change if the caller's list does.
    expect(event.changes).not.toBe(changes);
  });

  it('omits changes when there are none', () => {
    const event = makeAuditEvent('trash', ['a'.repeat(32)], { at, id: 'audit2' });
    expect('changes' in event).toBe(false);
    expect('note' in event).toBe(false);
  });
});
