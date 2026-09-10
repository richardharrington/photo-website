/**
 * Emailed submissions: the record, the claim rule, and the caption rule.
 *
 * A submission is a message that passed both proofs (design.md, "Submissions")
 * and whose image parts are now sitting under `inbox/` waiting for an
 * administrator to look at them. Nothing here touches storage; the repository
 * beside this file does that, and the Worker's `email()` handler is the only
 * thing that creates one.
 *
 * Two rules in particular are here rather than in a runtime because they are
 * the whole of what a test can pin: which claim is live, and what a subject
 * line proposes as a caption.
 *
 * Compiled into all three targets, so no DOM, Node, or Workers globals — and
 * nothing here may import `postal-mime`, which is Worker-only.
 */

import { INBOX_CLAIM_TTL_MINUTES, MAX_SOURCE_BYTES } from './constants.ts';
import { MAX_CAPTION_LENGTH } from './validation.ts';
import { detectFormat, MIME_BY_FORMAT } from './image-signature.ts';

export const SUBMISSION_SCHEMA_VERSION = 1;

/** One stored raw part, described. The bytes live at `submissionPartKey`. */
export interface SubmissionPart {
  index: number;
  /** As sent, sanitized for display only. Never used to decide anything. */
  filename: string | null;
  /** As **sniffed**, never as declared: see `image-signature.ts`. */
  contentType: string;
  bytes: number;
}

/**
 * Who is adding this submission right now.
 *
 * Adding is a browser-side job that takes seconds to minutes and two admin
 * tabs can be open, so the tab that starts writes a token here under an
 * ETag-guarded conditional write and carries it on every later write for this
 * submission. A stale claim expires rather than wedging.
 */
export interface SubmissionClaim {
  token: string;
  /** ISO instant the claim was taken. */
  at: string;
}

export interface Submission {
  schemaVersion: number;
  id: string;
  /** ISO instant the Worker received the message. */
  receivedAt: string;
  /**
   * Cloudflare destination-address id of the sender, **never the address**.
   * `inbox/` is read by the admin function and by the maintenance cron, and
   * neither should have to see an email address to do its job — the same rule
   * that keeps addresses out of the catalog and the audit log.
   */
  submittedBy: string;
  /** Raw and cleaned both, so the page can show one beside the other and a
   *  better rule later can re-propose from what was kept. */
  subject: string | null;
  proposedCaption: string | null;
  /** First non-quoted line of the plain-text body, when there was one. */
  bodyLine: string | null;
  parts: SubmissionPart[];
  claim: SubmissionClaim | null;
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

const CLAIM_TTL_MS = INBOX_CLAIM_TTL_MINUTES * 60 * 1000;

/** Milliseconds since a claim was taken, or null when there is no claim. */
export function claimAgeMs(submission: Submission, nowMs: number): number | null {
  if (!submission.claim) return null;
  return nowMs - Date.parse(submission.claim.at);
}

/**
 * Whether another tab still holds this submission.
 *
 * An expired claim is overwritable, which is what makes a closed tab
 * recoverable: the Inbox offers **Take over** once a claim is older than the
 * window, and every later write checks the token it was given.
 */
export function isClaimLive(submission: Submission, nowMs: number): boolean {
  const age = claimAgeMs(submission, nowMs);
  return age !== null && age < CLAIM_TTL_MS;
}

/**
 * Whether a write carrying `token` may proceed.
 *
 * A submission with no claim refuses every token: claiming is what a tab does
 * before it starts, so a write with no live claim behind it is a write from a
 * tab whose claim has already been taken over.
 */
export function claimMatches(submission: Submission, token: string): boolean {
  return submission.claim !== null && token !== '' && submission.claim.token === token;
}

// ---------------------------------------------------------------------------
// Which parts are photographs
// ---------------------------------------------------------------------------

/** A candidate MIME part, before anything has decided what it is. */
export interface CandidatePart {
  filename: string | null;
  bytes: Uint8Array;
}

export interface SelectedPart {
  index: number;
  filename: string | null;
  contentType: string;
  bytes: Uint8Array;
}

/**
 * Pick the photographs out of a parsed message's parts.
 *
 * **Sniffed, never declared.** Mail clients label HEIC as
 * `application/octet-stream` routinely and a `.jpg` name means nothing, so
 * only the first bytes are believed — the same signature check a dropped file
 * gets. Inline parts count as well as attachments, which means signature logos
 * and inline emoji arrive as parts; the Inbox shows those as tiny
 * thumbnail-less tiles and the administrator unticks them. The alternative,
 * attachments only, silently loses photographs from the clients that send them
 * inline.
 *
 * There is deliberately no size floor. A threshold would be a guess, and a
 * genuinely small photograph is still a photograph.
 *
 * Parts larger than the pipeline would accept are skipped here, so nothing
 * larger than it will ever take is stored.
 */
export function selectImageParts(
  candidates: readonly CandidatePart[],
  maxBytes = MAX_SOURCE_BYTES,
): SelectedPart[] {
  const selected: SelectedPart[] = [];

  for (const candidate of candidates) {
    const format = detectFormat(candidate.bytes);
    if (format === null) continue;
    if (candidate.bytes.byteLength > maxBytes) continue;

    selected.push({
      // Position among the *kept* parts, which is what the object key uses.
      index: selected.length,
      filename: sanitizeFilename(candidate.filename),
      contentType: MIME_BY_FORMAT[format],
      bytes: candidate.bytes,
    });
  }

  return selected;
}

/**
 * A sender's filename, made safe to render and to hand back to the pipeline.
 *
 * It reaches `downloadFilenameFor` and the filename-date fallback, both of
 * which sanitize again; this strips path separators and control characters so
 * nothing shaped like a path is ever stored or shown.
 */
export function sanitizeFilename(filename: string | null): string | null {
  if (filename === null) return null;
  const base = filename.split(/[/\\]/).pop() ?? '';
  const cleaned = base
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(new RegExp('[\\u0000-\\u001f\\u007f]', 'g'), '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return cleaned === '' ? null : cleaned;
}

// ---------------------------------------------------------------------------
// Subject to caption
// ---------------------------------------------------------------------------

/**
 * Reply and forward prefixes, in the languages a family's mail clients
 * actually emit. Stripped repeatedly, because `Fwd: Fwd: beach` is the
 * ordinary case rather than a corner of one.
 */
const PREFIX_RE =
  /^\s*(?:\[[^\]]*\]\s*)?(?:re|fwd?|tr|wg|aw|sv|vs|rv|enc)\s*(?:\[\d+\])?\s*:\s*/i;

/**
 * Subjects that are a mail client's default rather than anything the sender
 * wrote. iOS Mail offers "4 images"; several clients offer nothing at all and
 * the header arrives as a literal `(no subject)`.
 */
const DEFAULT_SUBJECT_RE = /^\d+\s+(?:images?|photos?|pictures?|attachments?|files?)$/i;
const DEFAULT_SUBJECTS = new Set([
  'image',
  'images',
  'photo',
  'photos',
  'picture',
  'pictures',
  'attachment',
  'attachments',
  '(no subject)',
  'no subject',
  'untitled',
]);

/** Everything from here down is a quoted reply, not this sender's words. */
const QUOTE_MARKER_RE =
  /^(?:On\b.*\bwrote:|-{2,}\s*Original Message\s*-{2,}|_{5,})\s*$/i;

/** The signature delimiter, which is exactly `-- ` and nothing else. */
const SIGNATURE_DELIMITER_RE = /^--\s?$/;

/** The digest's own footer, which a reply to one would otherwise offer up. */
const DIGEST_FOOTER_RE = /^This is a daily update from /i;

function stripPrefixes(subject: string): string {
  let text = subject;
  // Bounded: a pathological subject must not drive this forever.
  for (let i = 0; i < 12; i += 1) {
    const stripped = text.replace(PREFIX_RE, '');
    if (stripped === text) break;
    text = stripped;
  }
  return text.trim();
}

function isDefaultSubject(subject: string): boolean {
  const lower = subject.toLowerCase();
  return DEFAULT_SUBJECT_RE.test(subject) || DEFAULT_SUBJECTS.has(lower);
}

/**
 * The first line of the body worth reading, or null.
 *
 * Quoted text, the attribution line above it, the signature below it, and the
 * digest's own footer are all somebody else's words or the machine's. What is
 * left is the first thing this sender actually typed.
 */
export function firstBodyLine(bodyText: string | null): string | null {
  if (!bodyText) return null;

  for (const raw of bodyText.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    if (line.startsWith('>')) continue;
    if (SIGNATURE_DELIMITER_RE.test(raw)) break;
    // Everything from a quote marker or the digest footer onward is quoted
    // material; there is nothing of this sender's below it.
    if (QUOTE_MARKER_RE.test(line) || DIGEST_FOOTER_RE.test(line)) break;
    return line;
  }

  return null;
}

/** Truncate on a word boundary, so a caption never ends mid-word. */
function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return (space > limit / 2 ? cut.slice(0, space) : cut).trimEnd();
}

/**
 * What the Inbox's caption field is prefilled with.
 *
 * The subject line is the weakest input in this design — iOS Mail defaults it
 * to "4 images", a forward gives "Fwd: Fwd: beach", a blank gives nothing — so
 * this is a proposal and never a decision. It is in front of an administrator
 * before anything is committed, which is why the body fallback is worth having
 * even though it will sometimes offer a greeting.
 *
 * A multipart message with only an HTML body gives no fallback at all: reading
 * one line out of a body is as far as this goes, and parsing HTML to find it
 * is not.
 */
export function proposeCaption(
  subject: string | null,
  bodyText: string | null,
): string | null {
  const stripped = stripPrefixes(subject ?? '');
  if (stripped !== '' && !isDefaultSubject(stripped)) {
    return truncate(stripped, MAX_CAPTION_LENGTH);
  }

  const line = firstBodyLine(bodyText);
  if (line === null) return null;
  const truncated = truncate(line, MAX_CAPTION_LENGTH);
  return truncated === '' ? null : truncated;
}
