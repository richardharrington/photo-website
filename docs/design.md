# Photo Sharing Site Design

**Status:** Approved design record, revised 2026-08-30 after a design review
and again 2026-08-31 after both day-one spikes were executed against real
fixtures (see [decisions.md](decisions.md) and
[spike-findings-handoff.md](spike-findings-handoff.md)). Implementation is
planned in [implementation-plan.md](implementation-plan.md). The items under
[Implementation validation](#implementation-validation) are technical checks,
not unresolved product decisions.

## Goals

- Provide a small, curated family photo-sharing site.
- Organize photos by capture year, month, and day.
- Store nullable capture date, capture time, and caption for each photo.
- Provide a display-only site and an admin extension at a distinct URL path.
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
- Mobile administration beyond basic browser access; admin is laptop-oriented.

## Access and privacy model

The site uses shared-secret URLs, not authentication. Anyone who has a URL can
access the corresponding site. This is suitable only because every recipient is
trusted.

- The display URL and admin URL are separate, independent, high-entropy paths.
  Neither can be derived from the other.
- The display path can be shared with family; the admin path is shared only with
  administrators.
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
  Worker origin, and the WebAssembly codecs the admin app uses.
- These measures discourage indexing but are not access control.
- No client analytics, telemetry, external fonts, social metadata, or other
  third-party browser resources are used.

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
  WebP, so display derivatives are WebP-only. The **admin** app additionally
  requires a Chromium-based browser or Safari: Firefox runs the image
  pipeline roughly 10x slower and crashed on a fourth consecutive file, so it
  is unsupported for administration. Viewing the display site in Firefox is
  fully supported.
- UI: React, TypeScript, and Vite. The display and admin apps are two fully
  separate builds so no admin code can appear under the display path.
- Server API: Netlify Functions (catalog reads and mutations only; the server
  performs no image processing).
- Object storage: a private Cloudflare R2 bucket.
- **All image processing runs in the admin browser.** The admin app decodes
  sources (including HEIC, via a WebAssembly build of libheif), applies
  orientation, converts wide-gamut color to sRGB, validates size, and encodes
  all final artifacts with WebAssembly codecs (mozjpeg, libwebp) so output is
  identical in every supported browser. The browser then uploads the finished artifacts directly
  to R2 using narrowly scoped, short-lived signed PUT URLs issued by the
  server API. The original source file never leaves the administrator's
  computer; no server-side processing, background functions, or paid plan
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
  than binding: the administrator's current devices produce 12.2 MP images,
  and a 48.8 MP fixture measured about 12.5 seconds end-to-end, so the limit
  is comfortable. Dimensions are read from container/EXIF headers and checked
  *before* full decode, so an oversized file is rejected without first
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

## Display site

- The design is restrained and photo-first: neutral backgrounds, system
  typography, generous spacing, and no decorative UI competing with images.
  It follows the viewer’s system light/dark preference; there is no manual
  theme toggle initially. The configurable initial title is **Family Photos**.
- Navigation is newest-first: **year -> month -> day -> photo grid**.
- Group index pages show years, months, or days and their photo counts only;
  photos appear only in their chronological day grid and are not repeated as
  representative thumbnails.
- Individual years, months, days, and photos have stable deep URLs below the
  opaque display base. A photo’s ID-based detail URL is independent of its date,
  so date corrections do not break bookmarks. A trashed or permanently deleted
  photo URL returns a generic 404. There are no social widgets; sharing is
  copying a URL.
- Day grids lazy-load thumbnails as a viewer scrolls; larger derivatives are
  requested only when a photo opens. Derivative URLs are stable, so browsers
  cache images across visits.
- Selecting a photo opens a full-size lightbox with non-empty caption and
  capture date/time, previous/next navigation within the day, and a
  full-resolution sanitized-JPEG download action. Group labels use unambiguous
  text dates; viewer time presentation uses local-style hours/minutes, while
  admin information retains seconds/milliseconds.
- Within a day, photos with capture times sort chronologically. Date-only
  photos follow, ordered by upload batch and then by their position in the
  batch's selection/drop order; ingestion time is never presented as a capture
  time. Manual reordering is out of scope; an admin can set an approximate
  capture time when ordering matters.
- Photos without a date are in a separate **Undated** group. An admin can later
  assign or correct a date.
- Original filenames are not shown in the normal viewer grid. A photo
  information view shows the filename and available information.
- Captions serve as accessible image text. If absent, use a concise fallback
  such as "Photo from August 2, 2026" or "Undated photo." The lightbox and all
  controls support keyboard and focus accessibility.

## Admin site

The admin extends the display hierarchy and adds curation controls.

- Clicking a thumbnail opens a detail panel with editable date, time, caption,
  original filename/information, an original-size download action, and a delete
  action.
- Every thumbnail in the main admin grid shows the original filename. A
  persistent **Trash** navigation link with an item count leads to recovery and
  permanent-deletion controls.
- Normal click opens the detail panel. On laptop/desktop, dragging on empty
  grid area creates a marquee selection; modifier-click adds/removes individual
  photos from it.
- Bulk delete is available for selected photos and whole day/month/year groups.
  The confirmation states the selected count and applies to the exact photos
  shown at confirmation time. Bulk metadata edits are out of scope; date, time,
  and caption edits are per-photo only.
- Mobile viewing is responsive. Admin workflows are explicitly laptop-oriented;
  touch-specific bulk-selection UI is out of scope initially.
- Viewer empty states simply say “No photos here yet.” The admin makes its large
  upload drop area prominent when the library is empty and keeps it large and
  easy to target thereafter.
- The in-progress upload queue shows per-file states (processing, uploading,
  done, skipped as duplicate, failed with reason and retry). There is no
  persistent server-side “processing” area; a file either commits fully or
  leaves no record.

### Trash

- Delete marks photos trashed in the catalog immediately and presents a brief
  Undo action to restore the just-trashed photos. Stored objects do not move;
  trash and restore are pure metadata changes.
- Items are retained for 30 days, then automatically purged (objects deleted,
  records removed, audit retained).
- The trash provides an explicitly confirmed permanent-delete action.
- A deleted photo can be restored during its retention period. Trashed photos
  cannot be downloaded, but the Trash shows thumbnails, filenames, original
  date grouping, and deletion date for safe identification.
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
[spike-findings-handoff.md](spike-findings-handoff.md) and
[decisions.md](decisions.md).

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
- Run one manual pass in real Safari, as opposed to Playwright's WebKit,
  before launch.
- Check per-file memory release across a sustained batch in Chromium and
  Safari before attempting large batches.
- Bound the color-conversion error with a highly saturated wide-gamut
  fixture; the existing measurement used a low-saturation scene.
- Validate current Netlify/Cloudflare free-tier limits, supported cron
  features, and pricing during account setup; the site must run at $0/month.
- Implement and test the exact `launchd`/`rclone` configuration before launch.
- Video hosting remains a future, separately scoped capability.
