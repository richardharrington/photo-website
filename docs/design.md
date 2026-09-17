# Photo Sharing Site Design

**Status:** Approved design record, revised 2026-08-30 after a design review
and again 2026-08-31 after both day-one spikes were executed against real
fixtures (see [decisions.md](decisions.md); the full spike report survives
only in git history). Implementation is
planned in [implementation-plan.md](implementation-plan.md). The items under
[Implementation validation](#implementation-validation) are technical checks,
not unresolved product decisions.

## Goals

- Provide a small, curated family photo-sharing site.
- Organize photos by capture year, month, and day.
- Store nullable capture date, capture time, and caption for each photo.
- Provide a family site, where anyone with the link can view and add
  photographs, and an admin extension at a distinct URL path.
- Keep operations simple, free of monthly cost (free tiers only),
  privacy-conscious, and free of third-party browser tracking.

## Non-goals for the first release

- User accounts or person-specific authorization.
- Dropbox or Google Photos integration/synchronization.
- Video hosting.
- Public social sharing, analytics, third-party fonts, or third-party browser
  resources.
- Search, caption search, tag filtering, and “recent photos” views; browsing is
  initially only the chronological hierarchy.
- Bulk downloads as ZIP archives; downloads are initially per-photo only.
- In-app catalog import/restore; recovery uses the documented R2/laptop backup
  procedure initially.
- Per-person accounts or ownership of photographs; every family member acts
  with the same rights.
- Cross-device ownership of uploads.

## Access and privacy model

The site uses shared-secret URLs, not authentication. Anyone who has a URL can
access the corresponding site. This is suitable only because every recipient is
trusted.

- The display URL and admin URL are separate, independent, high-entropy paths.
  Neither can be derived from the other.
- The display path is the family link and can be shared among family members.
  Anyone holding it can view and add photographs, and edit, trash, restore,
  and permanently delete the photographs added from their own browser; the
  server enforces this by mode, not the page. The admin path is shared only
  with administrators and additionally allows editing, trashing, and
  permanently deleting any photograph, the Inbox, the Emails page, and the
  catalog export.
- A family browser keeps a random uploader token in its local storage and
  sends it with every change it makes. A photograph added through the family
  link stores only the token's hash, which is never shown to viewers and never
  written to the audit log. It identifies a browser, not a person, and it is
  what lets that browser alone edit, trash, restore, and permanently delete
  the photograph (family-own-trash.md, read-first-photo-view.md).
- The audit log records which link an act came through (`display-api` or
  `admin-api`) and nothing about who; there are no accounts, so it makes no
  person-level claim.
- The Netlify root and all incorrect paths return a plain 404 and reveal no
  route information.
- Image URLs follow the same capability-URL philosophy: each photo's derivative
  URLs contain the photo's cryptographically random ID and cannot be guessed or
  enumerated.
- `/robots.txt` is public and disallows all crawling. Every page, API response,
  and image includes `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet`.
  HTML also has the equivalent robots meta tag.
- Responses use `Referrer-Policy: no-referrer`, and pages carry a strict
  Content-Security-Policy permitting only same-origin resources, the image
  Worker origin, the R2 upload origin, and the WebAssembly codecs both apps
  use.
- These measures discourage indexing but are not access control.
- No client analytics, telemetry, external fonts, social metadata, or other
  third-party browser resources are used.
- The display URL travels by email to verified recipients **by choice**. A
  family member who asks for the daily notification receives the display path
  in every message, which is a capability they already hold — it is how they
  see the photographs at all. Nothing about a photograph travels with it: the
  message is a count and a link, in plain text, with no images and nothing
  that could report a read.
- The only new inbound path is **mail to one address**, accepted only from
  senders who are verified in the account, switched on for submissions, and
  DKIM-authenticated for their own domain — and nothing it carries is shown to
  anyone before an administrator has looked at it. An emailed original is
  stored untouched and never served to a viewer.
- No email address is written anywhere the site keeps: the catalog, the audit
  log, and the inbox all record a sender as Cloudflare's **address id**, and
  the pages resolve it against the account's list when they show it.
- The only party that ever holds a recipient's email address is Cloudflare,
  which already holds the photographs. There is no third-party mail service,
  no marketing platform, and no tracking pixel. The account's destination
  address list *is* the recipient list; nothing about an address is stored
  anywhere else except whether the digest goes to it and how far it has been
  told about.

## Deployment and account security

- The source repository may be public.
- Netlify hosts the application. Deploy previews and branch deploys are
  disabled; testing occurs locally, followed by direct production deployment.
- Cloudflare R2 stores photo files and catalog data.
- Cloudflare and Netlify accounts use unique password-manager credentials,
  passkey/authenticator MFA (not SMS where possible), and securely stored
  recovery codes.
- Configure provider usage/spend alerts from day one, with a small monthly
  budget threshold. Verify current free-tier limits during setup; the design
  must run entirely on free tiers.
- R2 credentials, route values, and signing keys are stored only as
  Netlify/Cloudflare environment secrets. They are never committed, logged,
  placed in client bundles, or generated into public build artifacts.
- The repository provides `.env.example` with variable names only.

## Technology

- Supported browsers are current Chrome, Safari, Firefox, and Edge releases.
  The viewer is responsive on current mobile Safari/Chrome; obsolete browsers
  such as Internet Explorer are unsupported. All supported browsers decode
  WebP, so display derivatives are WebP-only. **Uploading**, in either app,
  works in all of them: Firefox was once unsupported for it, and passed when
  re-measured after processing became strictly serial (decisions.md #20,
  #90). On a phone or tablet a photograph over 30 MP is refused before it is
  processed, with a message saying to add it from a laptop or email it in,
  because a phone's browser gives a page too little memory to encode one
  (decisions.md #91).
- UI: React, TypeScript, and Vite. The display and admin apps are two fully
  separate builds so no admin code can appear under the display path.
- Server API: Netlify Functions (catalog reads and mutations only; the server
  performs no image processing).
- Object storage: a private Cloudflare R2 bucket.
- **All image processing runs in the uploading browser.** Whichever app adds
  a photograph decodes
  sources (including HEIC, via a WebAssembly build of libheif), applies
  orientation, converts wide-gamut color to sRGB, validates size, and encodes
  all final artifacts with WebAssembly codecs (mozjpeg, libwebp) so output is
  identical in every supported browser. The browser then uploads the finished artifacts directly
  to R2 using narrowly scoped, short-lived signed PUT URLs issued by the
  server API. The original source file never leaves the uploader's
  device; no server-side processing, background functions, or paid plan
  features are required.
- The bucket remains private. A Cloudflare Worker serves display derivatives
  at unguessable ID-based capability URLs with long immutable cache lifetimes
  and no-index headers. Original-size downloads use short-lived (about five
  minute) HMAC-signed URLs.

## Data and storage

At the expected scale (100 photos initially, about 300/year, generally about
5 MB each), a separate database is unnecessary initially.

- A small, versioned JSON catalog in the private R2 bucket stores photo IDs,
  hashes, original filenames, normalized date/time values, captions, timestamp
  sources, derivative descriptors, upload ordering, and trash state.
- Catalog updates use conditional (ETag-guarded) writes to avoid overwriting
  another change; on conflict the writer reloads and retries.
- A small append-only audit log records uploads, metadata changes, trash/
  restore actions, and permanent deletions, including timestamps, affected IDs,
  and before/after metadata where useful. It does not claim person-level
  attribution in the shared-admin model.
- The admin provides a current catalog JSON download as a provider-independent
  curation export.
- Each stored object uses a generated, cryptographically random ID in its path
  and public photo URL. Content hashes stay internal and are only used for
  duplicate detection. Original names are stored as metadata and shown in photo
  information, preventing name collisions.
  Sanitized original-size downloads use the original basename with a `.jpg`
  extension.
- The catalog is kept with the media so it can be backed up and migrated
  together.
- Catalog snapshots are retained at full granularity for 30 days and thinned
  to one per day thereafter.

### Metadata

The user-facing metadata fields are nullable:

- capture date;
- capture time (valid only when a capture date exists; clearing a date clears
  its time);
- caption.

On ingest, timestamp precedence is:

1. embedded capture time (`DateTimeOriginal`);
2. other embedded creation timestamps;
3. an unambiguous timestamp extracted from the filename;
4. no date/time (Undated).

Metadata extraction runs in the admin browser during upload; the server
validates submitted values but does not re-extract them. EXIF timestamps are
read as naive camera-local strings and never revived into machine-local date
values: reviving them would reinterpret a zoneless wall-clock time in the
administrator's own timezone and could file early-morning photos under the
wrong calendar day. The catalog records
the selected timestamp source for diagnostics and later correction.
Camera-local calendar date/time is preserved for grouping; known offsets are
retained but timestamps are not shifted to a viewer timezone.

Filename parsing is intentionally conservative. It recognizes an unambiguous
`YYYYMMDD` date anywhere in a filename, including
`IMG_20260802_174850943_HDR.jpg`, and an adjacent unambiguous time where
present. It recognizes `HHMMSS` with optional fractional-second digits; the
example time is `17:48:50.943`. Fractional precision is retained internally for
ordering but normally not displayed. Ambiguous numeric date formats are not
parsed.

Captions are plain text with line breaks; they do not support HTML or Markdown.

### Image files

- Initial uploads accept JPEG, HEIC/HEIF, and PNG, up to 50 MB and 50
  megapixels per source file. The megapixel cap is forward-looking rather
  than binding: what the administrator's own devices produce is not yet
  known, but 12.2 MP fixtures processed in about 4-5.5 seconds and a
  48.8 MP fixture in about 12.5 seconds end-to-end, so the limit is
  comfortable across the plausible range. Dimensions are read from
  container/EXIF headers and checked *before* full decode, so an oversized file is rejected without first
  exhausting memory. Video, unsupported formats, and over-limit files are
  rejected with a clear message; oversized panoramas can be downsized
  manually before upload.
- The admin browser normalizes each accepted file to a sanitized,
  full-resolution sRGB JPEG at quality 92 with 4:4:4 chroma subsampling for
  original-size download, compositing transparent PNG pixels on white. It also
  produces responsive sRGB WebP derivatives at quality 82: approximately
  400 px thumbnails, 1,280 px standard display images, and 2,560 px
  large-lightbox images. Wide-gamut sources — Display P3 is the common case
  for Apple devices — are genuinely converted to sRGB by a matrix
  transformation applied in linear light, not merely relabelled, so stored
  pixel values agree with the sRGB profile the files declare.
- All derivatives and original-size downloads are physically upright, but the
  rule that achieves this is decode-path dependent and must not be
  generalized. libheif already applies the HEIF `irot` property during
  decode, so EXIF orientation must be *ignored* for HEIC sources — Apple
  writes a redundant `Orientation: 6` that would otherwise rotate the image a
  second time. Images decoded via `createImageBitmap` (with an explicit
  `imageOrientation: 'none'`) must have EXIF orientation applied.
- Because every artifact is re-encoded from decoded pixels, GPS and all other
  EXIF metadata are absent from every stored file. Capture date/time is
  retained only in the catalog; this was verified against real fixtures
  carrying genuine GPS coordinates. The untouched source file is never
  uploaded and remains only on the administrator's computer (and in its own
  archives).
- The sanitized full-resolution JPEG is frequently *larger* than the HEIC
  source it came from (quality 92 at 4:4:4 versus HEVC compression). This is
  expected, not a defect. Measured storage is roughly 2-5 MB per photo across
  all four artifacts — about 0.9 GB/year at 300 photos/year, comfortably
  inside R2's 10 GB free tier for several years.
- Exact-content duplicates are detected with a source-byte content hash and
  rejected by default, with a link to the existing photo. Re-dropping a
  folder that was partially uploaded is therefore safe and is the standard
  way to resume an interrupted batch.

## Ingestion and processing

The admin site always provides a large, easy-to-target multi-file drop area and
clicking it opens the filesystem picker. It supports multi-file drag-and-drop
for any practical number of selected files, using a small concurrent upload
queue with overall and per-file status rather than an arbitrary batch limit.

1. The admin app registers the batch; the server assigns it a global batch
   sequence number.
2. For each file in turn, the browser validates and decodes it, extracts
   metadata, computes the content hash, and encodes the four final artifacts.
   Decoding and encoding are strictly serial — one file at a time — because
   several simultaneous large decodes risk exhausting memory; only the
   uploads themselves run concurrently.
3. Files whose hash already exists in the catalog are marked
   “already uploaded – skipped,” with a link to the existing photo, and are
   not uploaded.
4. The browser uploads the four artifacts directly to R2 with per-file
   progress and retry, then calls a commit endpoint. The server verifies the
   uploaded objects and atomically creates the catalog record.
5. A committed photo is immediately visible in the display hierarchy. Nothing
   is persisted server-side before commit, so an interrupted batch leaves no
   partial records; the admin simply re-drops the folder and already-committed
   files are skipped. A daily cleanup job removes any orphaned objects from
   interrupted uploads.

## Family site

The display link is the family link (family-tier.md #1): anyone holding it
can look at the library, add to it, and correct, trash, and restore the
photographs added from their own browser. What only the administrator does
is described under
[Admin site](#admin-site).

- The design is restrained and photo-first: neutral backgrounds, system
  typography, generous spacing, and no decorative UI competing with images.
  It follows the viewer’s system light/dark preference; there is no manual
  theme toggle initially. The configurable initial title is **Family Photos**.
- The whole library is **one newest-first scrolling page**: year headings,
  month headings beneath them, day headings beneath those, and a masonry block
  of photos under each day. There are no index pages and no navigation between
  levels — reaching any photo is a scroll, not four clicks. The site name in
  the header is a link back to the plain address and the top of the library,
  since the address bar follows whatever section is being read. The current year and
  month headings pin to the top of the viewport while scrolling; a month slides
  up behind its year rather than over it.
- There are **two views of the library**, and a toggle beside the site title
  moves between them: **All photos by date taken**, the page just described,
  and **Recently added** at `/recent`. The current view is plain text; the other is a link.
  Capture date is right for finding a photograph and useless for noticing one —
  a box of scanned 1978 prints is new, and on the timeline it sits at the
  bottom of the page under a 1978 heading. The Recently added view is the only
  place on the site ordered by anything but the camera. When something has
  arrived that this browser has not been shown, a short notice in words —
  "New photos you haven't seen" — sits to the left of the Recently added
  label; it is remembered per device, is emphasis only, and clears on one
  visit.
- Below 40rem the header stays in normal flow and scrolls away, as the site
  title always has. At 40rem and above it pins, because the toggle has to be
  reachable from anywhere in a page that is years long. Everything else that
  pins — the year and month headings, the add bar, and the admin's selection
  bar — sits below it.
- The header also carries **Trash** with its count, beside the view toggle, but
  only while this browser's trash holds something: it appears after the first
  delete and disappears when the count returns to zero, and `/trash` stays
  reachable.
- Under the header sits the **add bar**. On a phone it reads **Add photos**
  and opens the picker; on a wider screen it reads **Drop photos here**, with
  the hint that it can be pressed too. It is pinned to the top of the page, so
  a photograph can be added wherever the reader has scrolled to in a library
  years long; it is a large panel while the library is empty and a slim bar
  once it is not, and it stands down while the photo view is open. There is no
  persistent server-side "processing" area; a file either commits fully or
  leaves no record. When the browser cannot keep its uploader token, a line
  under the hint says so at every width: "This browser can't remember your
  uploads after you close this page, so you won't be able to delete them
  after that." Silent storage eviction cannot be detected and gets no message.
- An added file is a photograph on the page immediately: a tile of its own,
  above the timeline, on the same grid as the library. It carries its filename
  at once — the one place the family sees a filename on a tile, since before a
  thumbnail exists it is the only way to tell one queued file from another —
  its own capture date within a moment, its picture as soon as the browser has
  encoded one, well before the upload finishes, and beneath it the per-file
  state (waiting, processing, uploading, finishing, added, skipped as a
  duplicate with a link to the photo already stored, failed with a reason and
  a retry). A duplicate whose twin is in the trash links to the trash only when
  this browser added that photograph, because the family's trash lists nothing
  else; for any other it says "This photo was added before and then later
  deleted. Ask the site admin if you want it to be restored.", with no link,
  and the file cannot be added again until the administrator restores it or it
  is purged. It opens into the same photo view as any other photograph, with
  **Edit** always offered, so a wrong date can be corrected and a caption written
  while the device is still working: a correction made before the file commits
  is carried into that commit, and one made afterwards is an ordinary edit.
  There is nothing to download or delete there, because nothing is stored yet.
  Once the batch has settled and the library has been reloaded, the
  photographs that landed leave this area; failures and duplicates stay until
  cleared.
- On a phone or tablet a photograph over 30 MP is refused on its tile before
  any processing, with a message saying it will work from a laptop or by
  email (decisions.md #91).
- A plain click or tap on a photograph opens it to read. The photo view shows
  its date (or "Undated"), its caption clamped to a few lines with **More**
  when it runs longer, and **Download original size**, **Edit**, **Delete**, and **Photo
  info**. **Edit** and **Delete** appear only on a photograph added from this
  browser; on any other photograph there is neither, disabled or otherwise,
  and the Delete key does nothing. Photo info on every photograph says where
  it was added from, "This device" or "Another device", so a missing Edit and
  Delete explain themselves.
  **Edit** brings up the form — date, time, caption, **Save changes** and
  **Cancel** — with Delete and Photo info beneath and no Download, and hides
  previous and next, so the arrow keys do nothing there. Nothing is saved
  until Save, which is available once something has changed and returns to
  the photograph with "Saved"; Cancel discards and returns. Escape leaves a
  field, then the info panel, then does nothing while an edit is unsaved, then
  leaves Edit. Closing the photograph still discards. While a field has focus
  the keyboard belongs to it: arrows move the caret, Escape leaves the field.
  With focus outside the form, Delete or Backspace is the same as the Delete
  button.
- Delete always confirms through the preview-and-confirm dialog ("Delete
  photos?" … "will move to the trash, where they are kept for 30 days"), and
  Enter confirms. The photo view then advances to the next photo (or the
  previous at the end, or closes if none remain), and a brief Undo appears and
  lasts five seconds regardless of what happens in the meantime.
- After an edit or a delete the page updates in place from the server's reply
  and quietly refetches the library afterwards, so the page never waits on a
  reload and never stays out of step for long. A restore, an Undo, a batch of
  uploads settling, and the admin's Inbox Add reload it too, wherever the
  reader is standing at the time: a photograph put back or added is in All
  photos and Recently added without refreshing the page.
- **Trash** is a page of its own: the grid, headed "Trash" with a count, and
  one line above it: "Photos added from this device that have been deleted are
  kept here for 30 days, then removed automatically. Tap one to look at it and
  restore it, or delete it permanently." It lists only the photographs added from this browser,
  including one the administrator trashed, and Photo info on each says "Added
  from: This device". Each tile gives its original date, the date it was
  deleted, and "Will be purged" with the date it will be. Tapping a trashed
  photograph opens the photo view with **Restore** and **Delete permanently**
  as its actions — no download, no plain delete, no edit form. Restore puts it
  back, closes the view, and updates the count. Delete permanently asks first,
  saying it cannot be undone, then removes the photograph and its files for
  good.
- What the family does not have: no selection or selection bar, no Select all
  on a day heading, no caption applied to many photographs at once, no edit,
  delete, or permanent delete of a photograph added from another browser, by
  email, or by the administrator, no Emails, no Inbox, no Export catalog, and no filename
  on a library tile. The server refuses those routes to the family link; the
  page not showing them is not the reason they are unavailable.
- **What counts as recently added** is a property of the photographs, not of
  the viewer, and it is one sentence: everything uploaded in the last 30 days,
  plus every photograph sharing an upload batch with any of it. The batch rule
  keeps one upload from being shown cut in half; there is no ceiling, so an
  import of 800 photographs appears whole. Trashed photographs are excluded
  throughout. The view can therefore be empty, which is an ordinary state
  rather than an error: it stays reachable and says "No photos uploaded in the
  last month."
- Those photographs are grouped by **upload sitting**, not by calendar day: a
  new group starts wherever more than six hours passes between two arrivals.
  The server names no day — an arrival is a genuine instant, and the family is
  scattered across timezones — so the browser labels each group in the reader's
  own zone: "Added today", "Added yesterday", the weekday name for two to six
  days ago, and a month-first date from seven days on. Beneath the heading, a
  line naming the capture span the sitting covers, at the coarsest granularity
  that fits: "photographs from September 1–3, 2026", "photographs from March
  1977 – August 1978", "and 4 undated". It is omitted only when it would
  restate the heading exactly — everything captured on the very day it was
  uploaded. Groups are newest first; within one, photographs follow the site's
  own capture order, newest capture first and undated last. Heading and
  subtitle pin together while the group's photographs scroll past.
- Upload sittings have **no addresses of their own**: the headings are plain
  text, and there is no `/recent/<date>`. A link to one sitting would stop
  meaning anything as soon as it aged out of the set. `/recent` itself is
  stable and shareable, and so is `/recent/photo/<id>`, which opens over the
  recent view and traverses it. A photograph whose sitting has aged out still
  opens from such a link; both arrows are simply disabled.
- The three levels are told apart by size before they are read — 32px, 20px,
  14px — and by a rule under the year headings only. A month and a day get
  none: their own photographs are the boundary.
- Counts appear beside each year and month heading, but not beside a day: a
  day's photographs are all on screen beneath it. Photos appear once, in their
  own day's block, and are never repeated as representative thumbnails on a
  heading.
- Individual years, months, days, and photos have stable deep URLs below the
  opaque display base, as do the Recently added view and a photograph opened
  from it. A year, month, or day URL renders the same page scrolled
  to that section; clicking a heading rewrites the address bar to its URL
  without adding a history entry. A photo’s ID-based detail URL is independent
  of its date, so date corrections do not break bookmarks. A well-formed URL for
  a section with no photos, and a trashed or permanently deleted photo URL,
  return a generic 404. There are no social widgets; sharing is copying a URL.
- The page lazy-loads thumbnails as a viewer scrolls; larger derivatives are
  requested only when a photo opens. Derivative URLs are stable, so browsers
  cache images across visits.
- Selecting a photo opens it full-size over the timeline, which stays where it
  was underneath. The photo view carries no header bar and no position count:
  the way back at the top left, and at the bottom left the stack described
  above: the date, the caption, and the actions; the form only after Edit. Clock time, original filename, and
  full-size dimensions live in the Photo info panel, which is a layer of its
  own: Escape closes it and leaves the photograph open, closing the photograph
  only on a second press, and clicking anywhere outside it closes it. Previous
  and
  next traverse the whole library in display order, stopping only at its two
  ends, and prefetch their own neighbours.
  On a phone held upright they sit together right under the picture, centred
  and well apart for a thumb, rather than either side of it, so the picture
  can use the screen's whole width; held sideways they stay beside it, where
  they cost the picture least. Labels use unambiguous text dates;
  viewer time presentation uses local-style hours/minutes, while admin
  information retains seconds/milliseconds.
- Within a day, photos with capture times sort chronologically. Date-only
  photos follow, ordered by upload batch and then by their position in the
  batch's selection/drop order; ingestion time is never presented as a capture
  time. Manual reordering is out of scope; an admin can set an approximate
  capture time when ordering matters.
- Photos without a date are in a separate **Undated** group. The
  administrator, or whoever added the photograph from the same browser, can
  later assign a date.
- Original filenames are not shown on the family's library or trash tiles. A photo
  information view shows the filename and available information.
- Captions serve as accessible image text. If absent, use a concise fallback
  such as "Photo from August 2, 2026" or "Undated photo." The lightbox and all
  controls support keyboard and focus accessibility.

## Admin site

The admin site is the family site with selection and four administrator-only
surfaces added: permanent deletion, the Inbox, the Emails page, and the catalog
export. It is the same one-page timeline, the same add bar, and the same photo
view, reached through its own opaque path, and everything below applies on top
of the [family site](#family-site)'s rules.

- The header also carries **Emails**, **Inbox** with its count, and **Export
  catalog**. Every thumbnail shows its original filename, and so does the top
  right of the photo view.
- In the admin's listings — the library, Recently added, and the trash — a
  plain click on a photograph **selects** it and nothing else; a
  **double-click** opens the photo view. On the keyboard, Enter opens and
  Space selects; on a touchscreen, a tap selects and a press-and-hold opens.
  A click on an already-selected photograph leaves the selection exactly as
  it is, which is why a double-click can open a photograph out of a
  selection of five and leave all five marked. Each listing says the gesture
  in a line of its own, and each tile carries it as a tooltip.
- Modifier-click (Command, or Control away from a Mac) toggles one
  photograph, and shift-click extends from the last photo clicked across any
  day, month, or year boundary, adding to the selection rather than
  replacing it. Every click moves the point a shift-click measures from,
  including a plain one. There is no marquee dragging. Escape clears the
  selection, and so does a click on the page margins either side of the
  grid. Each day heading carries a **Select all** for that day, shown only
  while one of its photos is unselected; it adds to the selection rather than
  replacing it, and there is no library-wide Select all. While anything is
  selected a bar pinned to the top of the page shows the count, **Delete
  selected**, **Deselect all**, and, at its right-hand end, a caption box; it
  is absent otherwise. No selection control is ever shown disabled. Delete
  and caption are the bulk actions; date and time are per-photo.
- The caption box, labelled **Apply caption to selected**, is one line.
  Typing brings up **Apply**, and Enter does the same. The caption *replaces*
  every selected photograph's caption. Nothing can be applied from an empty
  box, so captions are cleared one photograph at a time. When a photograph
  would lose a different caption, a confirmation lists each such photograph
  with its thumbnail and the caption it would lose; when none would, the
  caption applies at once. A five-second Undo follows, as it does a delete,
  and puts back each photograph's own caption, except one changed again in
  the meantime. After applying, **Applied** stands in place of the button
  for as long as every selected photograph carries the text in the box. The
  text stays while the selection changes and goes when the bar does. The
  trash has no caption box.
- The photo view never touches the selection: open a photograph, arrow to
  another, close, and the selection and its anchor are what they were. The
  files still on their way up are the one exception to the click rule — they
  have nothing to select, so their tiles open on a single click, on the same
  screen as the library's below them.
- Deleting a selection confirms through the same preview-and-confirm dialog as
  a single delete, applies to exactly the photos it named, and offers the same
  five-second Undo.

### Emails

- An **Emails** page at `/emails`, beside Trash in the header, is where the
  administrator decides what each address may do: add one, remove one, see whether its owner
  has confirmed it, see when they were last sent a digest, send oneself a test,
  and set three independent switches — **Notifications** (the daily digest),
  **Can submit** (mail from this address is accepted into the Inbox), and
  **Reviews inbox** (this address's digest says when the Inbox is waiting). Any
  combination is allowed, and all three are inert until the address is
  confirmed. All three start off when an address is added and stay off when it
  is confirmed: nothing is sent to an address, and nothing it sends is
  accepted, until the administrator switches it on by hand.
- A recipient who is confirmed and switched on receives **one plain-text email
  a day**, and only on a day something arrived: how many photographs were added
  since the last message they were sent, and a link to the Recently added view.
  No thumbnails, no per-photo text, no HTML; replies are not read.
- A recipient who **can submit** gets one extra line naming the submission
  address. It travels only to people already allowed to use it.
- A recipient who **reviews the inbox** gets a line saying how many emailed
  photographs are waiting, and receives the digest even on a day when nothing
  new arrived — the waiting is the news. That is the only exception to the
  "only on a day something arrived" rule, and a reviewer with an empty Inbox
  still gets nothing.
- Adding an address creates a destination address in the Cloudflare account,
  which is what sends its owner a confirmation link. Nothing is sent to an
  address until they click it — Cloudflare's rule, and the one click this
  otherwise-invitationless design asks of a recipient.
- Each recipient has their own watermark. Switching an address on starts its
  clock at that moment, so a new recipient is never told about the library that
  was already there, and switching one off and on again never backfills. A
  message that fails to send leaves that recipient's watermark alone, so
  tomorrow's covers both days; nobody else is affected.
- The count is of *live* photographs, so it matches what the link will show. A
  photograph uploaded and deleted before the digest is not announced.
- There is no unsubscribe link: an unsubscribe endpoint would be a new
  unauthenticated write path on a site whose whole access model is that it has
  none. The message says to ask whoever runs the site, and the administrator
  removes the address.
- The digest runs on the existing daily cron, after the maintenance pass, so
  the count describes the library as it stands after any purge.

### Submissions

- A family member the administrator has switched on can **email photographs to
  the site**, at a submission address separate from the one the digest is sent
  from. The subject line becomes the caption, and every attachment in one
  message gets the same one.
- Two independent proofs are required, and both every time. The From address
  must be a **verified destination address in the Cloudflare account with Can
  submit switched on**; and the message must **authenticate for that address's
  domain** — DMARC pass, or an aligned DKIM pass. Verification proves someone
  controls the mailbox; DKIM proves the message came from it. Neither alone is
  enough, and a forged From from anywhere else fails.
- Nothing a sender emails is shown to anyone until an administrator has looked
  at it. The photographs wait in an **Inbox** page in the admin app, where the
  administrator sees who sent what, corrects the caption, unticks anything that
  is not a photograph, and presses **Add**. Only then do they enter the
  library, through the exact pipeline a dropped file goes through. A committed
  emailed photograph is indistinguishable from a dropped one to the display
  site; its date is the moment it was added, as every photograph's is.
- Which parts are photographs is decided by **sniffing the bytes**, never by
  the declared type or the filename — mail clients label HEIC as
  `application/octet-stream` routinely. Inline parts count as well as
  attachments, so signature logos arrive too; they show as small
  thumbnail-less tiles and are unticked.
- The Inbox shows a photograph's own embedded thumbnail where it has one,
  which costs no decode at all. A HEIC has none, so those rows carry a
  **Show** button — and a card with several carries **Show all** — that
  decodes the photograph in the browser on request. Decoding happens only when
  asked and only one file at a time, because it is the slow, memory-hungry
  half of adding a photograph and a page of waiting messages must not do it
  unbidden. Nothing decoded to look at is stored or uploaded.
- **Emailed originals are stored, never decoded.** The server keeps the file
  byte for byte under an inbox prefix and does nothing else with it: no decode,
  no transform, and it is never served to a viewer. All the image work still
  happens in the administrator's browser.
- Refusals are silent for anyone who has not passed both proofs — the email
  analogue of the site's uniform 404, so a prober learns nothing. A sender who
  has passed both and sent no usable image, or arrived when the inbox is over
  its cap, gets an ordinary bounce saying so.
- Every sender who is accepted gets a plain-text receipt: how many photographs
  arrived, and that they will appear once they have been looked at. No links,
  no images, nothing that could report a read.
- Submissions are kept **30 days**. The daily maintenance pass then deletes
  them, parts and record alike, reviewed or not. An administrator away for a
  month loses them, which is the deliberate price of not holding
  GPS-bearing originals indefinitely.

### Trash

- Delete marks photos trashed in the catalog immediately and presents a brief
  Undo action to restore the just-trashed photos. Stored objects do not move;
  trash and restore are pure metadata changes.
- Items are retained for 30 days, then automatically purged (objects deleted,
  records removed, audit retained).
- Both trashes provide an explicitly confirmed permanent-delete action: the
  admin's for any selection, the family's one photograph at a time from the
  photo view, and only for photographs added from the same browser.
- The family's trash lists only the photographs added from the same browser,
  and a family member restores only those; the admin's lists everything.
- A family member restores or permanently deletes from the lightbox; an
  administrator restores or permanently deletes a selection.
- A deleted photo can be restored during its retention period. Trashed photos
  cannot be downloaded, but the Trash shows them on the same grid and photo
  view as the library, with thumbnails, original date, and deletion date (and,
  for an administrator, filenames) for safe identification; both images are
  short-lived signed URLs.
- The image Worker refuses to serve trashed photos. Because it briefly caches
  catalog state, a trashed photo's URLs may continue to work for up to about a
  minute (and images already viewed remain in viewers' browser caches); this
  is acceptable in the trusted-recipient model. Permanent deletion removes the
  objects themselves.

## Backup

The main source archives remain Dropbox and Google Photos; this site is a
curated subset. The irreplaceable portion is primarily its curation and
metadata.

- Catalog snapshots are created automatically whenever catalog data changes,
  with the retention policy described above.
- A `launchd` job on the administrator's laptop runs nightly, before IDrive,
  and uses an exact `rclone sync` mirror of the R2 bucket to encrypted local
  storage. Because trashed photos' objects remain in place, the mirror
  naturally includes the 30-day trash and catalog data.
- When R2 permanently removes an object—by the 30-day trash purge or a manual
  permanent deletion—the next mirror run removes it locally too. IDrive's
  existing nightly backup provides the additional copy.

## Implementation validation

Both original day-one spikes have been executed against real fixtures.
Results, measurements, and the defects they exposed are recorded in
[decisions.md](decisions.md); the full spike report was deliberately removed
from the working tree and survives in git history.

- **Browser pipeline: resolved.** The WASM pipeline correctly handles real
  Apple HEIC (including Apple's tiled `grid` encoding), EXIF orientation, PNG
  alpha, GPS stripping, and malformed input in both Chromium and WebKit, at
  roughly 4-5.5 seconds per 12.2 MP photo and 12.5 seconds at 48.8 MP. The
  full-resolution JPEG encode dominates that time; decode is comparatively
  cheap.
- **R2 conditional writes: confirmed at the API level; live check deferred.**
  Both write surfaces support ETag-guarded writes but signal conflicts
  differently. No Cloudflare account exists yet, so verifying real behaviour
  under concurrent writers moves to the Phase 1 account-setup checklist
  rather than blocking design.
- Check per-file memory release across a sustained batch in Chromium and
  Safari before attempting large batches.
- Bound the color-conversion error with a highly saturated wide-gamut
  fixture; the existing measurement used a low-saturation scene.
- Run photos from the administrator's own iPhone through the pipeline once
  available: every spike fixture was a sample downloaded from the web, and
  no genuine 48 MP HEIF Max capture — Apple's real 48 MP tile structure
  plus an HDR gain map — has been tested (the 48.8 MP fixture was an
  upsample). Residual risk is low, since a real 48-tile Apple grid
  composited correctly, but the gain-map path is untested.
- Validate current Netlify/Cloudflare free-tier limits, supported cron
  features, and pricing during account setup; the site must run at $0/month.
- Implement and test the exact `launchd`/`rclone` configuration before launch.
- Video hosting remains a future, separately scoped capability.
- **Family-tier device validation (2026-09-14): done.** Firefox on a Mac added
  five photographs of about 5 MB at a few seconds each and the tab survived,
  so uploading is supported there (decisions.md #20, #90). On an iPhone 12,
  mobile Safari's picker hands a HEIC over as a JPEG with its capture date
  intact; 12 MP and 24 MP photographs process, and a 48 MP one exceeds
  Safari's 1,536 MB page limit and reloads the page, so phones now refuse
  photographs over 30 MP with a message (decisions.md #90, #91). No 48
  MP-capable phone has been tested; one with more memory may allow more.
