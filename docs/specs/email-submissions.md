# Email submission of photos

Spec, 2026-09-09. A separate agent implements this. The decisions below are
settled unless marked "implementer's discretion". Where this spec and the code
disagree, the spec wins; where it and `docs/design.md` disagree, the spec wins
and the doc is updated (section 17). It extends
`docs/specs/email-notifications.md`, which is assumed built and read.

## 1. Outcome

A family member the administrator has switched on can email photographs to
the site. The subject line becomes the caption; every attachment in one
message gets the same caption. Nothing they send is shown to anyone until an
administrator has looked at it: the photos wait in a new **Inbox** page in the
admin app, where the administrator sees who sent what, corrects the caption,
unticks anything that is not a photograph, and clicks **Add**. Only then do
they enter the library, through the exact pipeline a dropped file goes
through.

The existing **Notifications** page is renamed **Emails** and gains two
switches per address, beside the one it already has:

|                   |                                                            |
| ----------------- | ---------------------------------------------------------- |
| Notifications     | receives the daily digest (unchanged)                      |
| Can submit        | mail from this address is accepted into the Inbox          |
| Reviews inbox     | this administrator's digest says when the Inbox is waiting |

Nothing new is bought or subscribed to. The domain, the Email Routing, the
send binding, the destination-address list, and the Worker all already exist
for the digest; this reuses them in the other direction.

## 2. The rule that does not move

`CLAUDE.md`: "The server never touches image bytes." This feature keeps the
half of that rule that matters and makes the other half precise:

- The server **stores** an emailed original, byte-for-byte, under an inbox
  prefix, and **never decodes, transforms, or serves it to a viewer**.
- Decoding, orienting, colour conversion, resizing, encoding, and EXIF/GPS
  stripping happen where they always did: in the administrator's browser, in
  `src/pipeline/`, one file at a time.

Rejected alternatives, for `decisions.md`:

- **Processing in the Worker** (WASM libheif/WebP inside Cloudflare, commit
  directly). Photos would appear seconds after sending with no administrator
  involved. Rejected: it ports the whole pipeline to a second runtime with a
  128 MB memory ceiling and a CPU-time cap that a 12 MP HEIC decode already
  strains; it creates a second orientation decision, a second colour path,
  and a second EXIF strip that must agree with the first; and it makes any
  allowed sender a publisher with no review.
- **A mailbox with a Download button** (store raw, administrator downloads
  and re-drops by hand). Least code. Rejected: it makes email a delivery
  channel rather than a submission path, and the caption is typed again.
- **Auto-process on the administrator's next visit** (no queue; the app
  commits every parked submission unattended and the administrator trashes
  what is unwanted). Rejected because of the caption: the subject line is the
  weakest input in this design — iOS Mail defaults it to "4 images", a
  forward gives "Fwd: Fwd: beach", a blank gives nothing — and the edit form
  edits one photo's caption at a time. Twenty photos captioned "20 images"
  are twenty round-trips to fix once committed, and one field to fix before.
  It would also have made every allowed sender a publisher, gated only by an
  administrator happening to open the app.
- **Auto-process into the Trash** as the review surface. Rejected: "restore"
  meaning "publish" is the wrong verb, and the 30-day purge would silently
  delete unreviewed submissions.

## 3. The path of a submission

```
sender ──mail to submit@<domain>──▶ Cloudflare Email Routing
                                          │ rule: submit@ → Worker
                                          ▼
                                    Worker `email()` handler
                                          │ allowed? authenticated? any image?
                                          │ no  → bounce or silent drop (§5)
                                          │ yes ↓
                                    R2  inbox/<submissionId>/message.json
                                        inbox/<submissionId>/parts/<n>       (raw)
                                    receipt mailed to the sender (§6)

                        … later, an administrator opens the admin app …

Inbox page ──GET /inbox──▶ list of submissions, oldest raw parts' EXIF
                           thumbnails fetched by Range request (§10)
administrator unticks junk, fixes the caption, clicks Add
                                          │
                                          ▼ claim (§8), then per ticked part:
admin browser ──presigned GET──▶ raw part ──▶ src/pipeline (unchanged)
              ──presigned PUTs─▶ photos/<id>/…  (four artifacts)
              ──POST /commit───▶ catalog record, caption = the field,
                                 submittedBy = the sender's address id
              ──POST /inbox/resolve──▶ raw parts and record deleted, audited
```

A committed emailed photo is indistinguishable from a dropped one to the
display site. It appears in the timeline, in Recently added, and in tomorrow's
digest counts exactly as any other photo does; its `createdAt` is the commit
instant (§9), not the instant the mail arrived.

## 4. Who may submit

Two independent proofs, both required:

1. **The From address is allowed.** The address, lowercased by
   `normalizeEmail`, is a destination address in the Cloudflare account, is
   **verified** there, and has `canSubmit: true` in the notification state
   (§7). The From header alone is read; `Reply-To` and `Sender` are ignored,
   and the display name is never used for anything, including the Inbox page
   (it is sender-controlled text).
2. **The message authenticates for that address's domain.** Cloudflare Email
   Routing adds an `Authentication-Results` header to every message it
   delivers to a Worker. The Worker accepts when that header shows
   `dmarc=pass`, or `dkim=pass` with a `header.d=` equal to the From domain or
   a parent of it (DMARC's relaxed alignment). Gmail, iCloud, Outlook,
   Yahoo, Fastmail, and Proton all sign, so real family mail passes; a forged
   From from anywhere else does not.

Requiring verification for "Can submit" is deliberate, and the same rule as
for Notifications: the switch is inert until the owner has clicked
Cloudflare's confirmation link. Verification proves someone controls the
mailbox; DKIM proves the message came from it. Neither alone is enough.

Rejected: From address alone (anyone who learns the submission address and a
family member's address can fill the bucket); a per-sender token in the
subject or a plus-address (strong, but it has to be delivered and remembered,
and it collides with subject-as-caption).

**Implementer's note on the header.** The exact `Authentication-Results`
format Cloudflare emits must be confirmed against a real message during
implementation and captured as a test fixture; the parser is a pure function
in `src/shared/` over the header string, so the fixture is the whole test.
The authserv-id in the header must be Cloudflare's own, and the parser must
read only the **first** `Authentication-Results` header in the message —
later ones can be attached by the sender.

## 5. Refusals

| Situation                                                   | What happens                                             |
| ----------------------------------------------------------- | -------------------------------------------------------- |
| To is not the submission address                            | silent drop                                              |
| From is not an allowed, verified, `canSubmit` address       | silent drop                                              |
| Authentication fails                                        | silent drop                                              |
| Allowed and authenticated, but no usable image part         | **bounce**: "No photos were found in your message…"      |
| Allowed and authenticated, inbox over its cap (§12)         | **bounce**: "…the site is not accepting photos just now" |
| Allowed and authenticated, some parts usable, some not      | accepted; unusable parts are ignored, no bounce          |
| Message over Cloudflare's size limit                        | never reaches the Worker; the sender's provider bounces  |

A silent drop is `message.setReject()` **not** being called and nothing being
stored: the Worker returns normally and the message is gone. This is the
email analogue of the site's uniform 404 — a probe learns nothing. A bounce
is `message.setReject(reason)`, which the sender's provider turns into an
ordinary delivery-failure message. Bounces go only to senders who have already
passed both proofs, so the reason text is feedback to family and an oracle to
nobody.

Every drop and bounce is logged (structured `console.log`, which the Worker's
observability already captures) with the reason and the From domain, never
the full address or the subject.

## 6. The Worker's `email()` handler

The asset Worker (`worker/src/index.ts`) gains an `email` handler alongside
`fetch` and `scheduled`. One Worker, one deploy, as before. New Worker secret:
`SUBMIT_ADDRESS`, the full address (`submit@<domain>`), compared against
`message.to` after normalization so a catch-all routing rule can never feed
this handler by accident. Missing `SUBMIT_ADDRESS` means the handler drops
everything — the same "unconfigured means inert" posture as the digest.

Order of work, cheapest check first:

1. `message.to` matches `SUBMIT_ADDRESS`, else drop.
2. `normalizeEmail(message.from)` is in the address list (read-only token,
   as the digest uses), verified, and `canSubmit` in the state, else drop.
   Both reads are the ones the digest already does; no new permission.
3. The `Authentication-Results` header passes (§4), else drop.
4. Inbox cap not exceeded (§12), else bounce.
5. Parse the MIME message from `message.raw`. Use `postal-mime` (runs in
   Workers, recommended by Cloudflare's own Email Workers docs); it is the
   first new runtime dependency in `worker/`. It must be imported only by
   Worker code, never by anything under `src/shared/`.
6. Select parts (below). Zero usable → bounce.
7. Write the raw parts, then the record (in that order: a record whose parts
   are missing is worse than parts with no record, and the purge (§12)
   removes the latter). Write the record with `ifAbsent`; the submission id is
   fresh, so a conflict is a bug.
8. Append an audit event, `submission-received` (§13).
9. Send the receipt (below). A failed send is logged and does not undo the
   submission.

**Which parts are photographs.** Every MIME part — attachment or inline, any
declared content type — whose first bytes **sniff** as JPEG, PNG, or
HEIF/HEIC using the same signature check `src/pipeline/validate.ts` already
applies to dropped files (factor it into `src/shared/` if it is not already
runtime-neutral). Declared `Content-Type` and `Content-Disposition` are
ignored for the decision; only the bytes are believed. Signature logos and
inline emoji will therefore arrive as parts. That is accepted: the Inbox
shows them as tiny or thumbnail-less tiles and the administrator unticks
them, whereas the alternative (attachments only) silently loses photos from
the clients that send them inline. No size floor; a threshold would be a
guess and a genuinely small photo is a photo.

Parts larger than `MAX_SOURCE_BYTES` are skipped at this stage, so nothing
larger than the pipeline will accept is ever stored. (Cloudflare's per-message
ceiling is well under it anyway; see §14.)

**The receipt.** One plain-text message from `NOTIFY_FROM` with the site
title as display name, exactly as the digest is sent, to the From address —
which is a verified destination address, so it is free and needs nothing new:

```
Subject: Got your photos for <site title>

<N> photo(s) from your message "<cleaned subject or (no subject)>" arrived
and will appear on <site title> once they have been looked at.

If some of what you attached is missing from that count, it was not a
JPEG, PNG or HEIC image.
```

Same style rules as the digest: no HTML, no images, no links back to the
site (the sender already has one, and the receipt is not a place to put a
capability), nothing that could report a read. The receipt is sent
regardless of whether the sender also receives the digest.

## 7. Recipient state: two new bits

`RecipientState` in `src/shared/notifications.ts` gains:

```ts
/** Mail from this address is accepted into the Inbox. */
canSubmit: boolean;
/** This administrator's digest reports a non-empty Inbox. */
reviewsInbox: boolean;
```

`NOTIFICATION_SCHEMA_VERSION` becomes `2`. `loadNotificationState` **upgrades
a version-1 object in memory** — both new fields `false` for every recipient
— and the next mutation writes it back as version 2. A version **newer** than
2 stays a hard failure, exactly as now. A rolled-back build therefore refuses
the file rather than silently writing back a shape that drops the two bits;
that is the existing convention and the reason for a bump rather than two
optional fields.

A recipient may have any combination: digest on and cannot submit, submit on
and no digest, both, neither. Switching `canSubmit` off does **not** remove
submissions already waiting in the Inbox; they were accepted in good
standing and the administrator decides them there.

`pruneNotificationState` is unchanged: an address Cloudflare no longer holds
loses all three bits together.

Two new admin routes beside `/notifications/set-enabled`:

|                                   |                            |
| --------------------------------- | -------------------------- |
| `POST /notifications/set-submit`  | `{ email, canSubmit }`     |
| `POST /notifications/set-reviews` | `{ email, reviewsInbox }`  |

Same validation, same refusal for an unverified address, same 404-shaped
errors. `GET /notifications` returns the two new booleans per recipient.

## 8. The inbox in R2

Prefix `inbox/`, added to `R2_KEYS`. Per submission:

```
inbox/<submissionId>/message.json
inbox/<submissionId>/parts/0
inbox/<submissionId>/parts/1
…
```

`submissionId` is generated like a photo id (`src/shared/ids.ts`): random,
hex, never derived from the message. Part objects are stored with the sniffed
content type and the sender's filename kept only in the record.

`message.json`:

```ts
interface Submission {
  schemaVersion: 1;
  id: string;
  /** ISO instant the Worker received the message. */
  receivedAt: string;
  /** Cloudflare destination-address id of the sender, never the address. */
  submittedBy: string;
  /** Raw and cleaned, so the Inbox can show both and the rule can change. */
  subject: string | null;
  proposedCaption: string | null;
  /** First non-quoted line of the plain-text body, when there was one. */
  bodyLine: string | null;
  parts: {
    index: number;
    filename: string | null;      // as sent, sanitized for display only
    contentType: string;          // as sniffed
    bytes: number;
  }[];
  /** Who is adding this right now, if anyone. */
  claim: { token: string; at: string } | null;
}
```

The **address id** goes in the record, not the address, for the same reason
the catalog carries no addresses: `inbox/` is read by the admin function and
the maintenance cron, and neither should have to see an email address to do
its job. The Inbox page resolves the id through the same address list the
Emails page shows; a sender since removed from Cloudflare is shown as "an
address that has since been removed".

**Claims.** Adding is a browser-side job that takes seconds to minutes, and
two admin tabs can be open. Before it starts, the tab writes `claim` with a
fresh random token under an ETag-guarded conditional write through the store
seam (`ifMatch` on `message.json`); the loser sees the conflict and shows the
submission as "Being added in another tab". A claim **expires after 15
minutes**; an expired claim can be overwritten by another tab's claim, and
the Inbox offers **Take over** on a submission whose claim is older than
that. Every later write for that submission (`/commit` with a
`submissionId`, `/inbox/resolve`, `/inbox/discard`) carries the token and is
refused with the uniform 404 if the stored claim does not match. Closing the
tab mid-add leaves artifacts already PUT but never committed, which is
exactly the case the existing orphan sweep handles, and leaves the claim to
expire.

Rejected: no claim, relying on content-hash duplicate detection at commit
(works, but the second tab burns a full decode to find out, and the page
cannot say "someone else is on this"); a heartbeat lock object (strongest,
most machinery, one more thing that can wedge).

**Listing.** `GET /inbox` lists `inbox/` through the store seam's `list`,
loads each `message.json`, and returns them **newest first** with the
sender's address resolved. The list is small by construction (§12). The
count in the header is this list's length; the App fetches it the way it
fetches `trashCount` and refetches it after any Inbox mutation.

**Reading a part.** `GET /inbox/part-url?submission=<id>&part=<n>` returns a
presigned S3 **GET** URL for the raw object, TTL five minutes — the same
pattern as `downloadLink`, on a different key. The browser fetches it
directly. Two uses: a `Range: bytes=0-<N>` request for the EXIF thumbnail
(§10), and a full fetch on Add. This requires the bucket's CORS rule to allow
`GET` with the `Range` request header and to expose `Content-Range`, which is
an operations change (§16), and it is the first time the admin browser reads
from R2 rather than only writing; the CSP already permits the host for
`connect-src` because presigned PUTs go there.

## 9. The catalog change

`PhotoRecord` gains one field:

```ts
/**
 * The Cloudflare destination-address id of the sender, when this photo
 * arrived by email; null for a dropped file. An id, never an address: the
 * catalog is loaded on every viewer request and must not carry one.
 */
submittedBy: string | null;
```

`CATALOG_SCHEMA_VERSION` **stays 1**; the field is added as optional on read
(`submittedBy?: string | null`, absent read as `null`) and always written.
Reasoning: bumping the catalog version touches snapshots, export, fixtures,
and every test fixture for the sake of a field whose loss on rollback costs
attribution and nothing else. The implementer must confirm that every catalog
mutation preserves fields it does not know about (spreads the record rather
than rebuilding it) and add a unit test that says so, so that even a rollback
would not strip the field.

`CommitInput` gains an optional `submissionId` and `claimToken`. When
present, the function loads `inbox/<submissionId>/message.json`, checks the
claim, and sets `submittedBy` from the record — the browser never supplies
the id itself. The display projection (`PublicPhoto` in
`src/shared/display-api.ts`) is a whitelist and is **not** changed; a test
asserts that a record with `submittedBy` set projects to an object without
it. The admin's own photo view shows one extra line under the filename,
"Emailed by aunt@…", resolved client-side against the recipient list the
admin already fetches for the Emails page.

`createdAt` is the **commit instant**, as for every photo: it is when the
photo became visible, which is what Recently added groups by and what the
digest watermark compares against. Five emails from last week added in one
sitting are one sitting and one digest count, which is the truth of what the
family can see. The receipt instant lives on the submission record and in the
audit trail, not on the photo. Rejected: `createdAt` = receipt instant (a
photo could then predate a digest watermark and never be announced, and
Recently added could grow a sitting in the past); a second `receivedAt`
field (a schema change for a nicety).

## 10. The Inbox page

A new admin page at `/inbox`, added to `ADMIN_PAGES`; header order
**Trash · Emails · Inbox (n)**, the count shown as Trash's is. Empty state:
"Nothing is waiting."

One card per submission, newest first:

```
aunt@example.com · Tuesday 8 September, 14:02 · 4 files
Caption  [ Beach day                                    ]
[✓] 🖼 IMG_4021.HEIC 3.1 MB   [✓] 🖼 IMG_4022.HEIC 2.9 MB
[✓] 🖼 IMG_4023.HEIC 3.4 MB   [ ] ▫ image001.png  4 KB
                                          [Discard]  [Add 3 photos]
```

- **Thumbnails** are the embedded EXIF thumbnail, read with
  `exifr.thumbnail()` from the first ~128 KB of the raw object fetched by
  Range request, rotated per the part's `Orientation` tag with a CSS
  transform (the thumbnail is stored unrotated). A part with no embedded
  thumbnail — PNGs, screenshots, images saved from the web, signature logos —
  shows a neutral tile with its filename and size, which is itself the signal
  the administrator needs. **No part is decoded before Add.** Thumbnail
  fetches are concurrent (they are tiny); they are not the serial pipeline.
  The implementer must confirm `exifr.thumbnail()` on a HEIC from
  `sample-photos/` and fall back to the neutral tile if it returns nothing.
- **Checkboxes** default to ticked for every part. A part under 32 KB
  defaults to **unticked** — implementer's discretion on the exact number;
  the aim is that a signature logo starts unticked and a photograph never
  does. The administrator can flip any of them.
- **Caption** is prefilled with `proposedCaption` (§11) and applies to every
  ticked part; per-photo differences are made later through the existing
  edit form. Validated by `validatePhotoEdit`'s caption rule before Add is
  enabled.
- **Add** claims (§8), calls `/begin-batch` once — one email is one batch,
  `selectionIndex` is part order among the ticked parts — then for each
  ticked part in order fetches the raw object, wraps it as a `File` with the
  sent filename and sniffed type, and hands it to `processFile` exactly as
  the upload queue does, with the same serial discipline: **reuse the upload
  queue** (`src/admin/upload/queue.ts`) rather than writing a second loop,
  feeding it `File`s from fetched blobs. Per-part progress and outcomes use
  the upload tile's own vocabulary: added; already in the library (with the
  same link-or-trash pointer the upload panel gives a duplicate); rejected,
  with the pipeline's reason. Unticked parts are never fetched.
- When every ticked part has reached an outcome, the page calls
  `POST /inbox/resolve { submissionId, claimToken, photoIds }`, which deletes
  the raw parts and the record and audits `submission-accepted`. If the tab
  dies before that, the claim expires and the submission reappears in full;
  re-adding it finds its already-committed parts as duplicates, which is the
  right answer.
- **Discard** asks for confirmation ("Discard 4 files from aunt@…? They will
  be deleted and cannot be recovered.") and calls
  `POST /inbox/discard { submissionId }`, which claims, deletes, and audits
  `submission-discarded`. Discarding is immediate and permanent; the Trash is
  for photos, and these never were.
- A card someone else has claimed shows "Being added in another tab, started
  3 minutes ago" with its controls disabled, and **Take over** once the
  claim is older than 15 minutes.

The Emails page's intro paragraph gains a second sentence explaining the two
new switches, and its table becomes:

Address · Status · Notifications · Can submit · Reviews inbox · Last sent ·
Actions

All three switches are inert until the address is verified, with the same
title text. Nothing else on the page changes.

## 11. Subject to caption

A pure function in `src/shared/`, `proposeCaption(subject, bodyText)`, unit
tested against a fixture list:

1. Take the subject. Strip, repeatedly, any leading `Re:`, `Fwd:`, `Fw:`,
   `FW:`, `TR:`, `WG:`, `AW:` (case-insensitive, optional brackets and
   trailing whitespace), then trim.
2. Drop the result entirely if it is only a mail client's default: matches
   `/^\d+ (images?|photos?|pictures?|attachments?)$/i`, or is exactly one of
   `image`, `photo`, `picture`, `photos`, `pictures`, `(no subject)`,
   `untitled`. Implementer's discretion to extend the list from real
   examples; the test fixture is the contract.
3. If nothing survives, fall back to the **first non-empty, non-quoted line
   of the plain-text body**: skip lines beginning with `>`, skip everything
   from the first line matching `/^On .* wrote:$/` or the digest's own
   footer onward, skip a line that is only a signature delimiter (`-- `),
   take the first remaining line, trimmed, truncated at the caption length
   limit on a word boundary. Multipart messages with only an HTML body give
   no fallback; the caption is then empty.
4. The result, or `null`.

Both the raw subject and the proposal are stored on the record (§8) so the
Inbox can show "Subject: Fwd: Fwd: beach" beside the field, and so a better
rule later can re-propose from what was kept. The body is **not** stored
beyond that one line: mail bodies carry quoted digests, signatures, and
whatever else, none of which the site should hold.

Accepted risk of the body fallback: the proposal will sometimes be a
signature or a greeting. The field is in front of the administrator before
anything is committed, so the cost is a glance.

## 12. Bounds

- **Retention.** The daily maintenance pass (`worker/src/maintenance.ts`)
  deletes any submission whose `receivedAt` is older than **30 days**
  (`INBOX_RETENTION_DAYS`, same number as the Trash), parts and record,
  claimed or not, and audits `submission-purged` with the submission id and
  part count. The sender is not told. An administrator away for a month
  loses those submissions, and that is the deliberate price of not holding
  GPS-bearing originals indefinitely.
- **Volume.** The Worker bounces (§5) when the inbox already holds more than
  **200 parts or 2 GB** (`INBOX_MAX_PARTS`, `INBOX_MAX_BYTES`), counted from a
  `list` of the prefix at receipt time. Cheap, approximate, and enough to
  stop a compromised family mailbox from filling the bucket.
- **Orphan sweep.** The existing sweep of `photos/` objects without a catalog
  record must **not** be extended to `inbox/`; the retention purge above is
  the inbox's only reaper. A test asserts the sweep leaves `inbox/` alone.

## 13. Audit

`AuditAction` gains `submission-received`, `submission-accepted`,
`submission-discarded`, `submission-purged`, and `AuditEvent.via` gains
`'email'`. `received` carries no photo ids and a note of the form
`submission <id>, <n> parts, from address <addressId>`; `accepted` carries
the committed photo ids; the others carry the submission id in the note.
Never the address, never the subject: the audit log is retained forever and
the catalog rule about addresses applies to it too.

Each committed photo's `upload` audit event is unchanged; `submittedBy` on
the record and `submission-accepted` together are the attribution trail.

## 14. Traps

- **`message.raw` is a stream and `rawSize` is the whole message.**
  Cloudflare Email Routing refuses messages over 25 MiB before any Worker
  runs, so nothing here needs to guard against a giant message, but the
  handler must not buffer the raw stream twice; `postal-mime` takes it once.
- **The From display name is attacker text.** Never render it. The Inbox
  shows the address resolved from the address id, which came from
  Cloudflare's list, not from the message.
- **`Authentication-Results` can be forged by the sender**; only the first
  header, with Cloudflare's authserv-id, counts (§4). The parser must not
  scan the whole header block for any `dkim=pass`.
- **Sniff, don't trust `Content-Type`.** Mail clients label HEIC as
  `application/octet-stream` routinely, and a `.jpg` name means nothing.
- **The pipeline takes a `File`.** Wrap the fetched blob:
  `new File([blob], filename ?? 'photo', { type: sniffedType })`. The name
  matters — `downloadFilenameFor` and the filename-date fallback read it.
  When the sender's client stripped EXIF, `timestampSource` will be
  `'filename'` or `'none'` and the photo lands in Undated, which is correct
  and which the Inbox should not try to fix.
- **EXIF thumbnails are stored unrotated.** Apply the `Orientation` tag as a
  CSS transform on the preview; do not run the pipeline's orientation code
  on it — that code compares decoded shape to tagged shape, and a thumbnail
  is not the decoded image.
- **Range on a presigned GET is a CORS question, not a signing one.** The
  signature does not cover `Range`; the bucket's CORS rule must allow the
  header (§16). A preflight failure looks like a network error with no
  status.
- **Do not let the store seam leak.** The claim is a conditional write and
  must go through `putConditional` and `ConditionalWriteResult`; the two
  adapters disagree about what a lost race looks like, and that is the
  seam's whole reason to exist. No try/catch around the claim.
- **The Worker now writes to `inbox/` from the `email` handler** and the
  cron deletes from it. The address token stays read-only; nothing here
  needs the write-capable one, and adding it to the Worker would be the
  mistake decisions.md #70 exists to prevent.
- **The fixture server is more permissive than production** (`CLAUDE.md`).
  Add every new route to `netlify/functions/admin.ts` first and let the
  fixture mount it, not the other way round.
- **Nothing in `src/shared/` may import `postal-mime` or `exifr`.** MIME
  parsing lives in `worker/`, thumbnail extraction in `src/admin/`; the pure
  rules (`proposeCaption`, the authentication-header parser, the part
  sniff) live in `src/shared/` and are compiled by all three tsconfigs.
- **The digest's "only on a day something arrived" rule bends for
  reviewers** (§15). Make the bend explicit in `planDigests`, not a special
  case in the executor.

## 15. Digest changes

Two additions to `src/shared/notifications.ts`, both pure:

1. **Footer for submitters.** When the recipient has `canSubmit`, the digest
   body ends with:

   ```
   To add photos of your own, email them to submit@<domain>. The subject
   line becomes the caption.
   ```

   Others' digests are byte-for-byte unchanged. The address is
   `SUBMIT_ADDRESS`, threaded into `DigestDeps`. The address travels only to
   people already allowed to use it.

2. **Waiting line for reviewers.** When the recipient has `reviewsInbox` and
   the inbox holds at least one submission, the body gains, after the
   opening:

   ```
   3 emailed photos from 2 messages are waiting to be looked at.
   ```

   and such a recipient receives the digest **even on a day with no new
   photos** — the subject then reads `Photos waiting for review on <site
   title>` and the opening is the existing "No new photos…" sentence. On a
   day with new photos the count line simply follows. `planDigests` gains an
   `inbox: { parts: number; messages: number }` argument; a reviewer with a
   zero count on a quiet day still gets nothing, as now. The watermark logic
   is untouched: a digest sent only for the waiting line advances
   `seenThrough` to the same value it already had.

The test button sends whatever the recipient would get tonight, including
both additions, so the administrator can see them.

## 16. Configuration and operations

Worker (`wrangler secret put`):

|                  |                                                            |
| ---------------- | ---------------------------------------------------------- |
| `SUBMIT_ADDRESS` | `submit@<domain>`; the handler drops everything without it |

Cloudflare dashboard, once, documented in `docs/operations.md` under a new
"Adding email submissions" heading beside "Adding email notifications":

1. Email Routing → Routing rules → Create: custom address `submit`, action
   **Send to a Worker**, destination `photo-assets`. (The digest's
   `photos@` address remains send-only; no rule for it.)
2. R2 → bucket → Settings → CORS: extend the existing rule for the admin
   origin with `GET` in `AllowedMethods`, `Range` in `AllowedHeaders`, and
   `Content-Range`, `Content-Length` in `ExposeHeaders`.
3. Set the secret, deploy the Worker, then send a test message from an
   address that is switched on and confirm it appears in the Inbox.

Netlify: no new variables. The admin function already holds the S3
credentials that presign PUTs; presigning a GET uses the same client.

Local: `npm install postal-mime` (Worker only). `config/fixture-server.ts`
gains a dev-only `POST /__dev/inbox` that accepts a multipart form of files
plus `from` and `subject`, builds a `Submission` in the in-memory store the
way the Worker would, and serves the parts at the fake presigned URL; the
Inbox page is then developable without a domain. `npm run dev:admin` seeds
nothing; the e2e test posts what it needs.

## 17. Documentation

- `docs/design.md`: the Notifications subsection becomes **Emails**, with
  the three switches; a new **Submissions** subsection states the flow, the
  two proofs, the review-before-publish rule, the caption rule, retention,
  and that emailed originals are stored but never decoded server-side. The
  "no replies" sentence about the digest becomes "replies are not read";
  submissions go to a separate address. The access-and-privacy list gains a
  bullet: the only new inbound path is mail to one address, accepted only
  from verified, switched-on, DKIM-authenticated senders, and nothing it
  carries is shown to anyone before an administrator has looked.
- `docs/decisions.md`: entries for the rejected alternatives in §2, §4, §8,
  §9, and §10 (thumbnail strategy), each with its reason.
- `docs/implementation-plan.md`: the `email()` handler, the inbox prefix,
  the claim, the Inbox page, the digest additions.
- `docs/operations.md`: §16, plus the retention purge in the maintenance
  section and `SUBMIT_ADDRESS` in the secrets table. No real address or
  domain in the file.
- `CLAUDE.md`: the architecture paragraph's "The server never touches image
  bytes" becomes "The server never decodes image bytes; emailed originals
  are stored under `inbox/` untouched until the admin browser processes
  them", and the invariants list gains the `inbox/`-is-not-swept rule and
  the address-id-never-address rule.

## 18. Tests

Unit (Vitest, Node):

- `proposeCaption`: the fixture list in §11, including every prefix form,
  the default-subject list, body fallback with quoted digest, signature
  delimiter, HTML-only body, over-long first line.
- Authentication-header parser: Cloudflare fixture passes; `dkim=pass` for
  an unaligned domain fails; a second forged header does not rescue a
  failing first; missing header fails.
- Part selection: sniffed HEIC labelled `application/octet-stream` accepted;
  a `.jpg`-named PDF rejected; oversize part skipped; zero usable parts
  reported as such.
- `planDigests` with the inbox argument: footer only for `canSubmit`;
  waiting line and quiet-day send only for `reviewsInbox`; watermark
  unchanged by a waiting-only send.
- Notification state v1 → v2 upgrade on read; v3 refused.
- Claim: two writers against `fixtures/in-memory-store.ts`, both conflict
  shapes; expired claim overwritable; live claim not; wrong token refused
  on commit, resolve, discard.
- Catalog: `submittedBy` round-trips through every mutation; projection
  omits it; a record without the field reads as `null`.
- Maintenance: retention purge removes only submissions older than 30 days;
  orphan sweep ignores `inbox/`.
- Worker `email()` with a fake message, fake address list, fake state, fake
  store: each row of the §5 table produces exactly its outcome and nothing
  else; the record is written after the parts; the receipt is sent last.

E2E (Playwright, all three projects, gated on `sample-photos/` like
`pipeline.spec.ts`):

- Post a two-part submission through `/__dev/inbox`; the header count
  reads 1; the Inbox shows the sender, the proposed caption, a thumbnail
  for the HEIC and a neutral tile for a PNG logo; untick the logo, edit the
  caption, Add; the photo appears in Recently added with that caption; the
  count reads 0; the raw parts are gone from the fake store.
- Discard removes without committing.
- A second browser context sees "Being added in another tab" while the
  first is mid-add.

## 19. Deliberately not decided

- A "your photos are now on the site" message after Add. The receipt says
  "once they have been looked at" and the digest says the rest; a second
  message per submission was judged not worth a new send path from the
  Netlify function. Revisit if senders ask.
- Per-part captions in the Inbox. The edit form exists for that.
- Submission by anyone who is not a digest-list address (a token in the
  address, a shared secret). The one list is the design.
- Reading the message body for anything beyond one caption line.
- Video, PDFs, or any format the pipeline does not already accept.

## Sources

- Cloudflare Email Workers: `EmailMessage` (`from`, `to`, `headers`, `raw`,
  `rawSize`, `setReject`, `forward`, `reply`), routing a custom address to a
  Worker, the 25 MiB message limit, and the recommendation of `postal-mime`
  for parsing — developers.cloudflare.com/email-routing/email-workers/.
- Cloudflare Email Routing's `Authentication-Results` header — to be
  confirmed against a real delivered message during implementation (§4).
- `exifr` thumbnail extraction (`exifr.thumbnail(input)` returns the
  embedded JPEG bytes or `undefined`) — github.com/MikeKovarik/exifr.
- DMARC relaxed alignment (RFC 7489 §3.1.1) for the `header.d=` rule.
- The existing spec, `docs/specs/email-notifications.md`, for everything
  this reuses: the address list as the recipient list, the read-only Worker
  token, the send binding, the state file, the test button.
