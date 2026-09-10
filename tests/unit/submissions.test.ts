import { describe, it, expect } from 'vitest';
import {
  claimMatches,
  claimAgeMs,
  firstBodyLine,
  isClaimLive,
  proposeCaption,
  sanitizeFilename,
  selectImageParts,
} from '../../src/shared/submissions.ts';
import type { Submission } from '../../src/shared/submissions.ts';
import { INBOX_CLAIM_TTL_MINUTES } from '../../src/shared/constants.ts';

// ---------------------------------------------------------------------------
// proposeCaption
// ---------------------------------------------------------------------------

/**
 * The subject line is the weakest input in this design, so the fixture list is
 * the contract. Each of these is a shape a real mail client produces.
 */
describe('proposeCaption', () => {
  describe('takes the subject once its prefixes are stripped', () => {
    it.each([
      ['Beach day', 'Beach day'],
      ['Re: Beach day', 'Beach day'],
      ['RE: Beach day', 'Beach day'],
      ['Fwd: Beach day', 'Beach day'],
      ['Fw: Beach day', 'Beach day'],
      ['FW: Beach day', 'Beach day'],
      ['TR: Beach day', 'Beach day'],
      ['WG: Beach day', 'Beach day'],
      ['AW: Beach day', 'Beach day'],
      // Repeatedly: a forwarded forward is the ordinary case.
      ['Fwd: Fwd: beach', 'beach'],
      ['Re: Fwd: RE: Beach day', 'Beach day'],
      ['Re[2]: Beach day', 'Beach day'],
      ['[Family] Fwd: Beach day', 'Beach day'],
      ['  Beach day  ', 'Beach day'],
    ])('%s', (subject, expected) => {
      expect(proposeCaption(subject, null)).toBe(expected);
    });
  });

  describe('drops a subject that is only the mail client talking', () => {
    it.each([
      '4 images',
      '1 image',
      '12 photos',
      '3 pictures',
      '2 attachments',
      'image',
      'photo',
      'picture',
      'photos',
      'pictures',
      '(no subject)',
      'untitled',
      'Untitled',
      // Stripped first, then judged: a forwarded default is still a default.
      'Fwd: 4 images',
    ])('%s', (subject) => {
      expect(proposeCaption(subject, null)).toBeNull();
    });
  });

  it('does not mistake a real subject for a default', () => {
    expect(proposeCaption('4 images from the wedding', null)).toBe(
      '4 images from the wedding',
    );
    expect(proposeCaption('Picture of Grandma', null)).toBe('Picture of Grandma');
  });

  it('falls back to the first line of the body when nothing survives', () => {
    expect(proposeCaption('(no subject)', 'Here they are at last\n\nLove, Aunt')).toBe(
      'Here they are at last',
    );
    expect(proposeCaption(null, 'A day at the beach')).toBe('A day at the beach');
  });

  it('skips a quoted digest in the body', () => {
    const body = [
      '> 3 new photos were added to Family Photos since your last update.',
      '>',
      '> See them here:',
      'Adding a few of my own',
      '',
    ].join('\n');
    expect(proposeCaption(null, body)).toBe('Adding a few of my own');
  });

  it('stops at the attribution line above a quoted reply', () => {
    const body = ['On Tuesday, someone wrote:', '> the beach was lovely'].join('\n');
    expect(proposeCaption(null, body)).toBeNull();
  });

  it('stops at the digest footer, which a reply to one carries', () => {
    const body = [
      'This is a daily update from Family Photos. To stop receiving it, ask',
      'whoever runs the site.',
    ].join('\n');
    expect(proposeCaption(null, body)).toBeNull();
  });

  it('stops at the signature delimiter, which is exactly "-- "', () => {
    expect(proposeCaption(null, '-- \nAunt Mary\nSent from wherever')).toBeNull();
    // Not a delimiter: a line that merely starts with dashes.
    expect(proposeCaption(null, '--- a caption ---')).toBe('--- a caption ---');
  });

  it('has no fallback for a message with only an HTML body', () => {
    // The parser hands back `text: undefined` for one, which arrives here as
    // null. Parsing HTML to find a line is not what this does.
    expect(proposeCaption('(no subject)', null)).toBeNull();
  });

  it('truncates an over-long first line on a word boundary', () => {
    const line = `${'word '.repeat(500)}end`;
    const caption = proposeCaption(null, line)!;
    expect(caption.length).toBeLessThanOrEqual(2000);
    // Cut between words, never through one.
    expect(caption.endsWith('word')).toBe(true);
  });

  it('is null when there is neither a subject nor a body', () => {
    expect(proposeCaption(null, null)).toBeNull();
    expect(proposeCaption('', '')).toBeNull();
    expect(proposeCaption('   ', '   ')).toBeNull();
  });
});

describe('firstBodyLine', () => {
  it('handles CRLF, which is what a mail body actually arrives as', () => {
    expect(firstBodyLine('\r\n\r\nHello there\r\n')).toBe('Hello there');
  });
});

// ---------------------------------------------------------------------------
// Which parts are photographs
// ---------------------------------------------------------------------------

function jpeg(bytes = 64): Uint8Array {
  const data = new Uint8Array(bytes);
  data[0] = 0xff;
  data[1] = 0xd8;
  return data;
}

function png(bytes = 64): Uint8Array {
  const data = new Uint8Array(bytes);
  data.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return data;
}

function heic(bytes = 64): Uint8Array {
  const data = new Uint8Array(bytes);
  const encoder = new TextEncoder();
  data.set(encoder.encode('ftyp'), 4);
  data.set(encoder.encode('heic'), 8);
  return data;
}

function pdf(bytes = 64): Uint8Array {
  const data = new Uint8Array(bytes);
  data.set(new TextEncoder().encode('%PDF-1.7'));
  return data;
}

describe('selectImageParts', () => {
  it('accepts a HEIC whatever the sender labelled or named it', () => {
    // Mail clients label HEIC as application/octet-stream routinely, and this
    // never looks at the declared type at all.
    const selected = selectImageParts([{ filename: 'IMG_4021.HEIC', bytes: heic() }]);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.contentType).toBe('image/heic');
  });

  it('rejects a PDF named .jpg: only the bytes are believed', () => {
    expect(selectImageParts([{ filename: 'holiday.jpg', bytes: pdf() }])).toEqual([]);
  });

  it('keeps JPEG, PNG and HEIC and drops everything else', () => {
    const selected = selectImageParts([
      { filename: 'a.jpg', bytes: jpeg() },
      { filename: 'notes.pdf', bytes: pdf() },
      { filename: 'logo.png', bytes: png() },
      { filename: 'clip.mov', bytes: new Uint8Array(64) },
      { filename: 'b.heic', bytes: heic() },
    ]);

    expect(selected.map((part) => part.filename)).toEqual([
      'a.jpg',
      'logo.png',
      'b.heic',
    ]);
    // Indexes number the *kept* parts, which is what the object keys use, so
    // a dropped part never leaves a gap in the inbox prefix.
    expect(selected.map((part) => part.index)).toEqual([0, 1, 2]);
  });

  it('skips a part larger than the pipeline would accept', () => {
    const selected = selectImageParts(
      [
        { filename: 'huge.jpg', bytes: jpeg(200) },
        { filename: 'small.jpg', bytes: jpeg(50) },
      ],
      100,
    );
    expect(selected.map((part) => part.filename)).toEqual(['small.jpg']);
  });

  it('reports zero usable parts as an empty list', () => {
    expect(selectImageParts([{ filename: 'notes.pdf', bytes: pdf() }])).toEqual([]);
    expect(selectImageParts([])).toEqual([]);
  });

  it('has no size floor: a genuinely small photograph is a photograph', () => {
    expect(selectImageParts([{ filename: 'tiny.png', bytes: png(20) }])).toHaveLength(
      1,
    );
  });
});

describe('sanitizeFilename', () => {
  it('keeps a basename and strips anything shaped like a path', () => {
    expect(sanitizeFilename('/etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('..\\..\\evil.jpg')).toBe('evil.jpg');
    expect(sanitizeFilename('IMG_4021.HEIC')).toBe('IMG_4021.HEIC');
  });

  it('strips control characters and collapses whitespace', () => {
    expect(sanitizeFilename('beach\n\tday.jpg')).toBe('beachday.jpg');
    expect(sanitizeFilename('  spaced   out.jpg ')).toBe('spaced out.jpg');
  });

  it('is null for a name made entirely of stripped characters', () => {
    expect(sanitizeFilename('   ')).toBeNull();
    expect(sanitizeFilename(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

const TTL_MS = INBOX_CLAIM_TTL_MINUTES * 60 * 1000;

function submissionWith(claim: Submission['claim']): Submission {
  return {
    schemaVersion: 1,
    id: 'a'.repeat(32),
    receivedAt: '2026-09-08T14:02:00.000Z',
    submittedBy: 'cf-1',
    subject: 'Beach day',
    proposedCaption: 'Beach day',
    bodyLine: null,
    parts: [],
    claim,
  };
}

describe('claims', () => {
  const at = '2026-09-08T15:00:00.000Z';
  const atMs = Date.parse(at);

  it('has no claim until one is taken', () => {
    expect(isClaimLive(submissionWith(null), atMs)).toBe(false);
    expect(claimAgeMs(submissionWith(null), atMs)).toBeNull();
  });

  it('is live inside the window and expired outside it', () => {
    const fresh = submissionWith({ token: 'tok', at });
    expect(isClaimLive(fresh, atMs + TTL_MS - 1000)).toBe(true);
    expect(isClaimLive(fresh, atMs + TTL_MS)).toBe(false);
  });

  it('matches only the exact token it was given', () => {
    const claimed = submissionWith({ token: 'tok', at });
    expect(claimMatches(claimed, 'tok')).toBe(true);
    expect(claimMatches(claimed, 'other')).toBe(false);
    expect(claimMatches(claimed, '')).toBe(false);
  });

  it('refuses every token when there is no claim at all', () => {
    // Claiming is what a tab does before it starts, so a write with no claim
    // behind it is a write from a tab whose claim has been taken over.
    expect(claimMatches(submissionWith(null), 'tok')).toBe(false);
    expect(claimMatches(submissionWith(null), '')).toBe(false);
  });
});
