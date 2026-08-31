# Photo Sharing Site Implementation Plan

## Purpose

Build the site described in [design.md](design.md) as a small React/Vite app on
Netlify, with private Cloudflare R2 storage. This plan resolves the remaining
implementation mechanics while preserving the deliberately simple shared-secret
access model. Key architectural choices and their rationale are recorded in
[decisions.md](decisions.md); the defining one is that **all image processing
runs in the admin browser**, so the server tier is small, stateless about
images, and free-tier only.

## Architecture

```text
Admin browser
  ├─ full image pipeline: decode (incl. HEIC via libheif-WASM), EXIF
  │  orientation, resize, encode (mozjpeg/libwebp WASM), SHA-256 hash
  └─ direct R2 PUTs of finished artifacts via presigned URLs

Viewer browser
  └─ static React display app; images from Worker capability URLs

Netlify
  ├─ static apps (two separate builds) + route-gating Edge Function
  └─ Functions: display API, admin API (catalog reads/mutations only)

Cloudflare Worker
  ├─ derivative delivery at unguessable ID-based capability URLs
  ├─ HMAC-signed URL verification for downloads and trash thumbnails
  └─ daily cron: trash purge, orphan sweep, snapshot pruning
       └─ private R2 bucket: photos, catalog

Administrator laptop
  └─ launchd + rclone sync: exact nightly R2 mirror -> local storage -> IDrive
```

There are no Netlify Background Functions and no server-side image libraries;
nothing in the stack requires a paid plan.

### Why the Cloudflare Worker exists

The Worker is a small R2 gateway, not a separate application UI. It:

- serves display derivatives at capability URLs (`/p/<photo-id>/<rendition>`),
  refusing unknown or trashed photos;
- validates short-lived HMAC-signed URLs for original-size downloads and for
  admin trash-view thumbnails;
- adds the required no-index and referrer headers to every asset response,
  plus long `Cache-Control: immutable` lifetimes for derivatives;
- runs the daily scheduled maintenance cron.

This avoids making R2 public and allows image responses—not just HTML—to carry
no-index directives. The Worker may use its default `workers.dev` URL; no custom
domain is required. To answer "is this photo trashed?" it reads
`catalog/current.json` and caches it for about 60 seconds, so it does not pay a
catalog read per image request; a trashed photo's URLs may therefore serve for
up to about a minute, which the design accepts.

## Repository structure

```text
src/
  display/                   viewer app entry (own Vite build)
  admin/                     admin app entry (own Vite build)
  shared/                    catalog types, date/validation logic, UI pieces
  pipeline/                  browser image pipeline (decode/orient/encode/hash)
netlify/
  edge-functions/gate.ts     opaque-path gate and rewrite
  functions/
    display.ts               read-only catalog/photo API
    admin.ts                 batch/commit, edit, trash, restore, export API
worker/
  src/index.ts               R2 asset gateway and scheduled maintenance
scripts/
  backup.sh                  rclone mirror invoked by launchd
docs/
  design.md
  implementation-plan.md
  decisions.md
  operations.md
public/                      robots file and static build inputs
```

The display and admin apps are **two fully independent Vite builds**, so no
shared chunk can place admin code under the display path. Add standard project
files: `package.json`, TypeScript/Vite configuration, `netlify.toml`, Wrangler
configuration, ESLint, Prettier, tests, and `.env.example`. The public
repository contains variable *names* only.

## Secrets and environment configuration

Create long random path segments and service secrets outside Git.

| Location | Variables |
| --- | --- |
| Netlify | `DISPLAY_PATH`, `ADMIN_PATH`, R2 S3 endpoint/account/bucket/key/secret, `ASSET_SIGNING_KEY`, `WORKER_BASE_URL`, `SITE_TITLE` |
| Cloudflare Worker | R2 bucket binding, `ASSET_SIGNING_KEY` |
| local development | values in ignored `.env` / Wrangler local secrets |

`DISPLAY_PATH` and `ADMIN_PATH` are separate random path segments. They are
shared URL secrets, not user identities. They are only used server-side for
routing and authorization. The admin path must never appear in display-app
assets. `ASSET_SIGNING_KEY` is the only secret shared between Netlify and the
Worker; there are no service-to-service calls between them.

## Opaque route handling

1. A Netlify Edge Function runs before static content and API handling.
2. It serves `/robots.txt` directly with `Disallow: /` and no-index headers.
3. It accepts only requests below the exact display or admin secret path,
   rewrites them to their respective internal app/API locations, and returns a
   plain 404 for all other paths.
4. It removes the external secret prefix before invoking the internal function.
   Functions receive an access mode (`display` or `admin`) set by the Edge
   Function, rather than trusting a browser-supplied mode.
5. Each client build uses relative API paths beneath its own secret base. The
   display build contains no admin route, admin API route, or admin secret.
6. Static assets are emitted under their corresponding opaque base paths at
   deployment. A visitor who knows a base URL can naturally retrieve that app's
   assets; the public source repository does not reveal either base URL.

Apply `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet` and
`Referrer-Policy: no-referrer` at the Edge Function, Netlify function, and
Worker layers. HTML also includes the robots meta tag. HTML responses add a
strict `Content-Security-Policy`: same-origin resources, `img-src` including
the Worker origin, `connect-src` including the R2 upload endpoint (admin app
only), and `'wasm-unsafe-eval'` for the admin app's WASM codecs. No
origin/referrer checking is performed at the Worker: image loads carry neither
header under this design, so signed URLs and capability URLs are the access
model.

## R2 object layout

Use generated random photo IDs, never hashes or original names, in paths.

```text
catalog/current.json
catalog/snapshots/<timestamp>.json
catalog/audit/<timestamp>-<random>.json
photos/<photo-id>/full.jpg
photos/<photo-id>/thumb.webp
photos/<photo-id>/display-1280.webp
photos/<photo-id>/display-2560.webp
```

Four objects per photo; derivatives are WebP-only because every supported
browser decodes WebP. Objects never move: trash state lives in the catalog,
and only permanent deletion or the purge cron removes objects.

Conditional writes with the R2 object ETag are used for every catalog
mutation. If a conditional write conflicts, reload and retry against the
latest catalog rather than overwriting it. A day-one spike verifies
ETag-conditioned PUTs through both the S3 API and Worker bindings; the
documented fallback is routing all catalog mutations through a single Worker
endpoint.

## Catalog model

`current.json` contains a schema version, a batch counter, and a `photos` map.
A photo record contains at least:

- random `id` and source content hash (internal only);
- original filename, generated JPEG download filename, source MIME type;
- nullable `captureDate`, `captureTime`, optional timezone offset, and
  timestamp source;
- nullable plain-text caption;
- `batchSeq` and `selectionIndex` (upload ordering), creation/update
  timestamps, and nullable `trashedAt`;
- derivative descriptors (pixel dimensions, byte sizes);
- audit correlation IDs.

There is no processing state: a record exists only for a fully uploaded,
ready photo. Date/time validation is shared by API and UI: time requires a
date; clearing a date clears time. Public routes always look up by ID and
return 404 for any trashed or unknown record.

Within a day, photos with capture times sort chronologically; date-only and
undated photos sort by `(batchSeq, selectionIndex)`—batches in upload order,
files in the order they were selected or dropped.

## Upload and commit flow

1. **Begin batch.** The admin app registers a drop/selection; the admin API
   increments the catalog batch counter and returns `batchSeq`. Each file
   gets a `selectionIndex` from its position in the selection.
2. **Process locally.** For each file the browser validates extension/type
   and the 50 MB limit, decodes it (libheif-WASM for HEIC), rejects sources
   over 50 megapixels, applies EXIF orientation, extracts metadata with
   `exifr` using the precedence in `design.md` (conservative filename parsing
   only when needed), computes the source-byte SHA-256, and encodes the four
   artifacts: full sRGB JPEG (quality 92, 4:4:4, PNG alpha flattened on
   white) and 400/1280/2560 px sRGB WebP derivatives (quality 82). All
   encoding uses WASM codecs (mozjpeg, libwebp) for identical output in every
   browser.
3. **Prepare.** The browser sends hash and filename. If the hash exists in
   the catalog, the API reports the existing photo and the UI marks the file
   “already uploaded – skipped” with a link—no error styling, no upload.
   Otherwise the API returns a generated photo ID and four short-lived,
   single-object presigned PUT URLs.
4. **Upload.** The browser PUTs the four artifacts directly to R2, with a
   small concurrent queue (initially three files in flight) and overall plus
   per-file progress and retry.
5. **Commit.** The browser calls `commit` with the photo ID, metadata,
   ordering fields, and descriptors. The API HEAD-verifies all four objects,
   re-checks hash uniqueness, and creates the record in one conditional
   catalog write. The photo is immediately live in the display hierarchy.
6. **Failure and resume.** Nothing is persisted server-side before commit. A
   failed file shows its reason and a retry control; a closed tab simply
   leaves uncommitted files out of the catalog. The documented resume path is
   re-dropping the folder—already-committed files are skipped by the hash
   check. The daily cron deletes `photos/<id>/` prefixes that have no catalog
   record and are older than a 24-hour grace period.

## Read and write APIs

All app APIs are reached through the opaque external base and Edge Function.
Functions return generic 404 for an unavailable/unauthorized resource.

### Display API

- hierarchy/group queries for year, month, day, and Undated;
- photo detail and sibling navigation;
- short-lived signed download URL for a photo's full-resolution JPEG.

Derivative URLs are not issued by the API: the client composes them from
`WORKER_BASE_URL` and the photo ID. They are stable, so browsers cache
thumbnails across visits. The client initially requests thumbnails only,
lazy-loads further grid items, and requests larger renditions on lightbox
open. Signed download URLs last about five minutes.

### Admin API

- begin-batch, prepare, and commit (upload flow above);
- per-photo date/time/caption update;
- trash, restore, manual permanent delete, and bulk deletion;
- current catalog JSON export;
- trash listing (returns signed thumbnail URLs, since the Worker refuses
  capability-URL access to trashed photos; it never signs full-resolution
  URLs for trashed photos).

Every destructive request is a two-step preview/confirm: the preview endpoint
resolves the selection or date-group query to an **explicit photo ID list**,
returns the count, and issues a fresh confirmation token bound to exactly that
ID list. The confirm endpoint acts only on those IDs, so a photo committed
between preview and confirm can never be swept in silently. The UI shows a
brief Undo action after a successful trash operation. This does not turn the
shared admin URL into true authentication, but prevents accidental UI/API
replay.

## Asset Worker

- `GET /p/<photo-id>/<rendition>` — capability URL for derivatives. The
  Worker consults its (≤60 s cached) catalog copy, returns 404 for unknown or
  trashed IDs, and otherwise serves the object with content type, no-index
  and no-referrer headers, and `Cache-Control: public, max-age=31536000,
  immutable`.
- `GET /d/...` — signed URLs encoding photo ID, rendition, expiration, and an
  HMAC signature (`ASSET_SIGNING_KEY`). Used for five-minute full-resolution
  downloads (with `Content-Disposition` using the sanitized download
  filename) and for admin trash-view thumbnails. Invalid or expired links
  return 404.

The Worker runs a daily cron task that:

1. purges catalog records whose 30-day trash expiration has passed: deletes
   their four R2 objects, conditionally removes the records from the catalog,
   and retains their audit events;
2. deletes orphaned `photos/<id>/` prefixes absent from the catalog and older
   than the 24-hour grace period;
3. prunes catalog snapshots: keep all snapshots newer than 30 days, thin
   older ones to one per day.

## UI implementation order

1. Build shared navigation, light/dark system styling, empty/404 states, and
   display hierarchy with fixture catalog data.
2. Build day grid, lazy thumbnails, lightbox, info view, keyboard focus and
   previous/next navigation.
3. Build admin layout, always-large upload drop target, the browser pipeline
   and upload queue (per-file states: processing, uploading, done, skipped,
   failed+retry), detail panel, and metadata form.
4. Build desktop marquee/modifier selection and delete confirmations/Undo.
5. Build Trash list, restore/permanent-delete flows, catalog export, and audit
   visibility where useful.

Do not implement search, tags, albums, manual reordering, ZIP downloads, mobile
bulk selection, catalog import, or video features.

## Testing

- Unit-test timestamp precedence, filename patterns including
  `IMG_20260802_174850943_HDR.jpg`, date/time validation,
  `(batchSeq, selectionIndex)` ordering, hash duplicate detection, download
  signatures, confirmation-token/ID-list binding, and catalog conflict
  retries.
- Exercise the browser pipeline against fixtures for portrait EXIF
  orientation, GPS metadata, JPEG, PNG transparency, 48 MP iPhone HEIC,
  wide-gamut input, missing timestamps, and malformed files—in Chrome,
  Safari, and Firefox (Playwright), asserting output dimensions, sRGB
  conversion, and metadata stripping.
- Integration-test the opaque-route gate: root/incorrect path 404, display
  cannot reach admin, trashed photo 404 from both API and Worker,
  no-index/referrer headers everywhere, CSP present.
- Test upload retry, interrupted-batch re-drop resume (duplicates skipped),
  orphan sweep, lifecycle purge, snapshot pruning, group deletion, Undo,
  restore, and permanent deletion.
- Use Playwright for desktop keyboard/lightbox/admin selection flows and
  mobile viewer layout.
- Before launch, inspect delivered JPEG/WebP bytes to verify GPS/EXIF absence
  and verify Worker signature/expiry and trash-refusal behavior.

## Operations

### Netlify and Cloudflare setup

- Disable deploy previews and branch deploys.
- Restrict R2 bucket CORS to the production Netlify origin with the methods
  and headers the presigned PUTs need. (Uploads are `cors`-mode fetches, so
  the browser sends a real `Origin` header here even under
  `Referrer-Policy: no-referrer`.)
- Configure Cloudflare Worker cron and R2 binding.
- Configure provider spend/usage alerts; re-check current free-tier limits.
  Everything in this plan must fit free tiers.
- Use only production deployment after local testing.

### Nightly mirror

`scripts/backup.sh` runs `rclone sync` from R2 to an encrypted directory on the
administrator laptop. It is intentionally an exact mirror: items permanently
deleted or purged from R2 disappear locally on the next run; IDrive's nightly
backup provides the additional historical copy. Because trashed photos'
objects stay in place, the mirror includes the full 30-day trash.

Install a `launchd` plist to run before IDrive's nightly schedule. Log each run
locally and fail visibly; do not embed credentials in the plist. Store the R2
rclone remote configuration in the user profile with restricted permissions.

### Recovery

The catalog JSON export, R2 catalog snapshots, audit records, local mirror, and
source archives provide recovery inputs. There is deliberately no in-app import
and no maintenance-mode feature; restore is a documented operator procedure:
restore matching R2 objects first, then conditionally replace the catalog, and
**make no admin edits until the restore is complete** (a violated ordering
surfaces as a conditional-write conflict, not silent loss).

## Delivery phases

1. **Foundation:** scaffold, lint/test/build/deploy configuration, opaque
   gate, environment docs, fixture catalog, display UI, and the two day-one
   spikes (browser WASM pipeline fixtures; R2 conditional writes via S3 API
   and bindings).
2. **Storage pipeline:** R2 client, catalog repository, asset Worker
   (capability URLs + signed downloads), browser pipeline, begin-batch/
   prepare/upload/commit flow, and re-drop resume.
3. **Curation:** admin metadata/detail panel, upload-queue UX, trash/restore,
   selection/delete/Undo, audit/export.
4. **Hardening:** maintenance cron, backup scripts/operations docs,
   CSP/headers, integration/E2E tests, account alerts, and launch checklist.

A phase is complete only after its tests pass and the corresponding acceptance
behavior in `design.md` is demonstrated.
