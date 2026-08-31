# Operations

How to set this site up, run it, and recover it. The design is in
[design.md](design.md), the plan in
[implementation-plan.md](implementation-plan.md), and the reasoning behind the
architecture in [decisions.md](decisions.md).

**Nothing here has been executed yet.** No Cloudflare or Netlify account
exists, so every account-dependent step below is a checklist item rather than a
record of something done. Everything that does not need an account — both apps,
the image pipeline, the catalog logic, the Worker, the gate — is implemented
and tested locally against the fixtures described under
[Local development](#local-development).

## Local development

No account of any kind is needed.

```sh
npm install
npm run dev:display   # viewer,  http://localhost:5173/dev-display-path/
npm run dev:admin     # admin,   http://localhost:5174/dev-admin-path/
npm run dev:harness   # pipeline harness for the browser tests
npm run check         # format, lint, typecheck, unit tests
npm run test:e2e      # Playwright, Chromium + WebKit + mobile Safari
```

`config/fixture-server.ts` mounts a stand-in for the display API, the admin
API, and the asset Worker directly in the Vite dev server. It runs the *real*
projection and mutation code over an in-memory object store, so the contract
and the conditional-write logic being exercised are the production ones; only
the storage and the image bytes are fake.

The development builds print a warning and use placeholder path segments. A
build with `NETLIFY=true` and a missing variable fails instead, so a real
deploy cannot fall back to a guessable path.

### Image pipeline fixtures

`tests/e2e/pipeline.spec.ts` needs real photographs, which are **not** in the
repository — `sample-photos/` is gitignored because the repository may be
public. Those tests skip when the directory is absent rather than passing
vacuously.

The four fixtures used during development were Apple HEICs: two portrait with
`Orientation: 6` and genuine GPS coordinates, one landscape with
`Orientation: 1`, and one with no orientation tag. All four are Display P3.
Any similar set works; the tests read what they need from the files.

## Account setup

Everything below must be done once, before the first production deploy. The
site must run entirely on free tiers.

### Cloudflare

- [ ] Create the account with a unique password-manager credential and
      passkey or authenticator MFA — **not SMS** where a choice exists. Store
      the recovery codes securely.
- [ ] Create the R2 bucket. Keep it **private**; nothing in this design ever
      makes it public.
- [ ] Restrict bucket CORS to the production Netlify origin, allowing `PUT`
      and the `content-type` header. The browser uploads are `cors`-mode
      fetches, so a real `Origin` header is sent even under
      `Referrer-Policy: no-referrer` — this rule does work, unlike an
      origin check on image loads.
- [ ] Create an S3-compatible API token scoped to that one bucket.
- [ ] Deploy the Worker (`npx wrangler deploy`) and note its `workers.dev`
      URL. No custom domain is needed.
- [ ] `npx wrangler secret put ASSET_SIGNING_KEY` — the same value that goes
      into Netlify.
- [ ] Confirm the daily cron trigger is registered (`wrangler.toml`,
      `17 4 * * *`).
- [ ] **Verify R2 conditional writes against the live bucket.** See
      [Conditional-write verification](#conditional-write-verification) below.
- [ ] Re-check the current free-tier limits: R2 storage, Class A/B
      operations, and Worker requests. Measured usage is roughly 2–5 MB per
      photo across all four artifacts, about 0.9 GB/year at 300 photos/year,
      against a 10 GB free tier.
- [ ] Configure a spend alert with a small monthly threshold.

### Netlify

- [ ] Create the account with the same credential hygiene as above.
- [ ] **Disable deploy previews and branch deploys in the site settings.**
      `netlify.toml` skips those builds, but the UI setting is the real
      control.
- [ ] Set the environment variables from `.env.example`. Generate each secret
      fresh: `openssl rand -hex 16` for path segments,
      `openssl rand -base64 32` for keys.
- [ ] Confirm `DISPLAY_PATH` and `ADMIN_PATH` are independent random values.
      Neither may be derivable from the other, and the gate refuses to serve
      anything if they are equal.
- [ ] Configure a spend alert.
- [ ] Deploy, then walk the [launch checklist](#launch-checklist).

### Conditional-write verification

Both write surfaces support ETag-guarded writes, but they report a conflict in
structurally different ways, and the adapters translate each to one normalized
result (decisions.md #22). The unit tests pin both translations against an
in-memory fake with explicitly asserted semantics — deliberately **not**
Miniflare, whose `onlyIf` handling has been reported inverted
(`workers-sdk#6411`, closed as not planned), so a backwards implementation
could pass against it.

What remains is to confirm the real bucket behaves as documented:

1. `PUT catalog/current.json` with `If-Match` set to the current ETag —
   expect success and a new ETag.
2. Repeat with the now-stale ETag — expect **HTTP 412** on the S3 path.
3. From a Worker, `put(key, value, { onlyIf: { etagMatches: <stale> } })` —
   expect a **`null` return with no exception**.
4. `PUT` with `If-None-Match: *` against an existing object — expect a
   conflict.

If any of these differ, the documented fallback is to route every catalog
mutation through a single Worker endpoint, which serializes them.

## Backup

The main archives remain Dropbox and Google Photos; this site is a curated
subset, and the irreplaceable part is the curation and metadata rather than the
pixels.

- [ ] Install `rclone` and configure an `r2-photos` remote in the user profile
      (`~/.config/rclone/rclone.conf`), with restricted file permissions.
- [ ] Point `PHOTO_BACKUP_DEST` at encrypted local storage.
- [ ] Edit the two `CHANGEME` paths in
      `scripts/com.family.photo-backup.plist`, copy it to
      `~/Library/LaunchAgents/`, and `launchctl load` it.
- [ ] Run `scripts/backup.sh` by hand once and confirm it completes and logs.
- [ ] Confirm the schedule lands **before** IDrive's nightly run.

`scripts/backup.sh` is an exact mirror, on purpose: anything permanently
deleted or purged from R2 disappears locally on the next run, and IDrive
provides the historical copy. Because trashed photos' objects stay in place,
the mirror includes the full 30-day trash along with the catalog, its
snapshots, and the audit log.

Two guards exist because a backup that quietly stops working is worse than
none, since it is trusted:

- `--max-delete` refuses a run that wants to delete an implausible number of
  files, which is far more likely to be a misconfigured remote than a real
  mass deletion.
- A completed mirror with no `catalog/current.json` is treated as a failure,
  because a mirror without the catalog is not a usable restore point whatever
  else it contains.

Failures log and raise a macOS notification.

## Recovery

There is deliberately no in-app import and no maintenance mode. With a single
administrator, "make no edits until the restore is complete" is a runbook line,
and a violation of it surfaces loudly as a conditional-write conflict rather
than as silent loss (decisions.md #14).

Recovery inputs, in rough order of convenience: the local `rclone` mirror, the
catalog JSON export from the admin app, the `catalog/snapshots/` objects in
R2, the audit log, and finally the source archives in Dropbox and Google
Photos.

**Order matters.** Restore in this sequence:

1. **Make no admin edits from this point until the restore is finished.**
2. Restore the matching `photos/<id>/` objects first. A catalog entry pointing
   at objects that do not exist yields broken images; an object with no
   catalog entry is invisible and is swept by the cron after 24 hours.
3. Only then replace `catalog/current.json`, as a conditional write against
   its current ETag. If that write conflicts, someone edited during the
   restore — reload and redo the merge rather than forcing it.
4. Confirm the Worker serves a few restored photos. It caches the catalog for
   about a minute, so allow for that.

To recover a single photo, take its record from a snapshot and its objects
from the mirror; the record's `derivatives` descriptors say what should be
there.

## Launch checklist

Run against production after the first deploy.

- [ ] `/` and a handful of wrong paths return a plain 404 with no route
      information.
- [ ] `/robots.txt` is served and disallows everything.
- [ ] `/.netlify/functions/admin` returns 404 from outside, including with a
      forged `x-photo-access-mode: admin` header.
- [ ] The display path serves the viewer; the admin path serves the admin app.
- [ ] The display app's HTML and JS contain no occurrence of the admin path.
- [ ] Every response carries `X-Robots-Tag` and `Referrer-Policy: no-referrer`
      — pages, API responses, **and images**.
- [ ] HTML carries the strict CSP; the display CSP contains neither
      `wasm-unsafe-eval` nor the R2 origin.
- [ ] Upload a real photo end to end from the administrator's own device.
- [ ] **Download the stored artifacts and inspect the bytes for EXIF and GPS.**
      There should be none: every artifact is re-encoded from decoded pixels.
      Verify against a source that genuinely had coordinates.
- [ ] Check a portrait photo is upright in the grid, the lightbox, and the
      downloaded original.
- [ ] `/p/<id>/full` returns 404; the full-resolution original is reachable
      only through a signed link.
- [ ] A signed download link works, and stops working after five minutes.
- [ ] Trash a photo, confirm its capability URLs stop serving within about a
      minute, then restore it.
- [ ] Trigger the Worker cron manually
      (`npx wrangler dev --test-scheduled`) and confirm it reports sensibly
      against a bucket with nothing yet to purge.
- [ ] Run one nightly backup and confirm the mirror contains the catalog, the
      snapshots, the audit log, and the photo objects.

## Known gaps

Carried forward from design.md's validation list, and still open:

- **No genuine 48 MP iPhone HEIF Max capture has been tested** — Apple's real
  48 MP tile structure plus an HDR gain map. The 48.8 MP fixture used during
  the spikes was an upsample. Residual risk is low, since a real 48-tile Apple
  grid composited correctly, but the gain-map path is untested.
- **Photos from the administrator's own iPhone have not been through the
  pipeline.** Every fixture was a sample downloaded from the web.
- **Sustained-batch memory has not been measured** beyond a five-file run.
  Check per-file memory release in Chromium and Safari before attempting a
  large batch.
- **Colour conversion has not been bounded against a highly saturated
  wide-gamut fixture.** The unit tests check the conversion against an
  independent floating-point reference across the colour cube, which covers
  the arithmetic; what is untested is a real saturated photograph end to end.
- Live R2 conditional-write behaviour, per the checklist above.
- Video hosting remains a future, separately scoped capability.
