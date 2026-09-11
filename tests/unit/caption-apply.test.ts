import { describe, expect, it } from 'vitest';
import {
  captionSlot,
  planCaption,
  reverseCaptionChanges,
} from '../../src/admin/caption-apply.ts';
import { toPublicPhoto } from '../../src/shared/display-api.ts';
import { makePhoto, testPhotoId } from '../../fixtures/photos.ts';

/**
 * The caption box's rules, without the box. docs/specs/bulk-captions.md 4.1
 * is the table `captionSlot` implements.
 */

function photo(seed: string, caption: string | null) {
  return toPublicPhoto(makePhoto({ id: testPhotoId(seed), caption }));
}

describe('captionSlot', () => {
  const idle = { inFlight: false, appliedOnce: false };

  it('shows nothing while the box is empty or only whitespace', () => {
    for (const text of ['', '   ', '\t']) {
      expect(captionSlot({ ...idle, text, selectedCaptions: [null] })).toBe('blank');
    }
  });

  it('offers Apply for text the photos do not all carry', () => {
    expect(
      captionSlot({ ...idle, text: 'Beach', selectedCaptions: [null, 'Beach'] }),
    ).toBe('apply');
  });

  it('offers Apply, not Applied, for a caption nobody has applied yet', () => {
    // Every photo already says it, but Applied confirms an act, and there
    // has not been one.
    expect(
      captionSlot({ ...idle, text: 'Beach', selectedCaptions: ['Beach', 'Beach'] }),
    ).toBe('apply');
  });

  it('shows Applied once this bar has applied and every photo carries it', () => {
    const after = { inFlight: false, appliedOnce: true };
    expect(
      captionSlot({ ...after, text: ' Beach ', selectedCaptions: ['Beach', 'Beach'] }),
    ).toBe('applied');
    // One more photo selected that does not match, and it is Apply again.
    expect(
      captionSlot({ ...after, text: 'Beach', selectedCaptions: ['Beach', null] }),
    ).toBe('apply');
    // An empty box is still blank, applied or not.
    expect(captionSlot({ ...after, text: '', selectedCaptions: [null] })).toBe('blank');
  });

  it('shows Applying… while a request is out, whatever else is true', () => {
    for (const text of ['', 'Beach']) {
      for (const appliedOnce of [false, true]) {
        expect(
          captionSlot({
            text,
            inFlight: true,
            appliedOnce,
            selectedCaptions: ['Beach'],
          }),
        ).toBe('applying');
      }
    }
  });
});

describe('planCaption', () => {
  it('plans nothing for an empty box', () => {
    const plan = planCaption([photo('a', 'Old')], '   ');
    expect(plan).toEqual({ caption: null, selected: 1, changes: [], replaced: [] });
  });

  it('leaves out photos that already say it, and lists only lost captions', () => {
    const none = photo('none', null);
    const same = photo('same', 'Beach, July 2019');
    const other = photo('other', 'Low tide');

    const plan = planCaption([none, same, other], '  Beach, July 2019 ');

    expect(plan.caption).toBe('Beach, July 2019');
    expect(plan.selected).toBe(3);
    expect(plan.changes).toEqual([
      { photoId: none.id, caption: 'Beach, July 2019', expected: null },
      { photoId: other.id, caption: 'Beach, July 2019', expected: 'Low tide' },
    ]);
    expect(plan.replaced).toEqual([{ photo: other, expected: 'Low tide' }]);
  });

  it('treats a difference in case as a different caption', () => {
    const lower = photo('lower', 'beach');
    const plan = planCaption([lower], 'Beach');
    expect(plan.replaced).toEqual([{ photo: lower, expected: 'beach' }]);
  });

  it('keeps the order it was given', () => {
    const photos = ['c', 'a', 'b'].map((seed) => photo(seed, `Caption ${seed}`));
    const plan = planCaption(photos, 'New');
    expect(plan.changes.map((change) => change.photoId)).toEqual(
      photos.map((entry) => entry.id),
    );
    expect(plan.replaced.map((row) => row.photo.id)).toEqual(
      photos.map((entry) => entry.id),
    );
  });
});

describe('reverseCaptionChanges', () => {
  it('puts back only what the server changed, expecting what was applied', () => {
    const [a, b, c] = ['a', 'b', 'c'].map((seed) => testPhotoId(seed)) as [
      string,
      string,
      string,
    ];
    const reversed = reverseCaptionChanges(
      [
        { photoId: a, caption: 'Beach', expected: null },
        { photoId: b, caption: 'Beach', expected: 'Low tide\nSecond line' },
        { photoId: c, caption: 'Beach', expected: 'Skipped' },
      ],
      [b, a],
    );

    expect(reversed).toEqual([
      { photoId: a, caption: null, expected: 'Beach' },
      { photoId: b, caption: 'Low tide\nSecond line', expected: 'Beach' },
    ]);
  });
});
