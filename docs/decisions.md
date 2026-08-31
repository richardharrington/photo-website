# Design Decisions — 2026-08-30 review

A review of the original design/plan found flaws, mostly platform assumptions
in the image pipeline. Each was resolved in a structured Q&A with the site
owner. This log records what changed and why, so future readers understand
the architecture without reconstructing the conversation.

## Constraints established

- **Budget is strictly $0/month.** Free tiers only. This ruled out Netlify
  Background Functions (historically a paid-plan feature), which the original
  plan depended on for server-side image processing.
- **Admin browser is flexible** — whichever browser works best; no
  requirement to support processing in all of them, but no dependence on one.
  *(Amended by #20: admin requires Chromium or Safari; Firefox is
  unsupported.)*
- **HEIC must be handled**, because the owner's iPhone produces it by
  default, but converting it during upload (rather than storing it) is fine.

## Decisions

1. **All image processing moved to the admin browser.** The original plan's
   server-side `sharp` pipeline had two fatal problems: prebuilt `sharp`
   cannot decode iPhone HEIC (HEVC patent licensing), and Background
   Functions violate the $0 constraint. The browser now decodes (HEIC via
   libheif-WASM), orients, resizes, encodes, and hashes; the server only
   issues presigned PUT URLs and maintains the catalog. Side effect: the
   original source file never leaves the laptop.

2. **WASM encoders (mozjpeg/libwebp, e.g. jSquash), not canvas.toBlob.**
   toBlob offers no chroma-subsampling control, differs across browsers, and
   Safari cannot encode WebP. WASM gives identical, tunable output
   everywhere, at a few seconds per photo.

3. **sRGB everywhere; no ICC/P3 preservation.** The fidelity loss is marginal
   for family photos; true originals remain in Dropbox/Google Photos.
   *(Amended by #19: sRGB output must be genuinely converted, not relabelled.)*

4. **Source cap lowered from 100 MP to 50 MP** (50 MB unchanged). Covers all
   current phones (48 MP iPhone); halves worst-case decode memory in the
   browser. The check is natural client-side since the browser decodes
   anyway (the old plan's browser-side check was impossible for HEIC in
   Chrome/Firefox). *(Amended by #21: the check must read header dimensions
   before decode; see also the note on the cap's justification.)*

5. **WebP-only derivatives + full-resolution JPEG (4 objects/photo, was 7).**
   Every browser in the design's own support matrix decodes WebP; the JPEG
   fallback derivatives served nobody.

6. **Catalog records are created only at commit.** Upload all four artifacts,
   then one atomic conditional catalog write. This deletes the
   processing-state machine, stale-record handling, and retry endpoints, and
   closes the duplicate-race window (hash uniqueness is enforced in the same
   conditional write). Orphaned objects from interrupted uploads are swept by
   the daily cron after a 24-hour grace period.

7. **Re-drop is the resume mechanism.** Duplicates during a re-drop show as
   “already uploaded – skipped” (neutral, with a link), not as errors.

8. **Derivatives use unsigned capability URLs; only downloads are signed.**
   The original 1-hour signed URLs made every thumbnail uncacheable. Photo
   IDs are already cryptographically random, so `/p/<id>/<rendition>` is
   itself an unguessable capability URL — the same trust model as the site's
   secret paths — served with long immutable caching. Full-resolution
   downloads keep 5-minute HMAC-signed URLs.

9. **Trash is a catalog flag; objects never move.** R2 has no rename, so the
   old trash/ prefix meant copy+delete per object with undefined
   partial-failure states. The Worker refuses trashed photos using a ~60 s
   cached catalog; the up-to-a-minute revocation lag is immaterial because
   viewers' browser caches retain seen images anyway and all recipients are
   trusted.

10. **Date-only ordering is (server-assigned batch sequence, selection
    index).** The old browser-assigned sequence restarted every batch,
    breaking the promised stable order across batches.

11. **Snapshot retention: full for 30 days, then thinned to one per day**,
    enforced by the daily cron. The original plan grew without bound.

12. **Bulk-delete confirmation tokens bind an explicit photo ID list**, not a
    re-run query — closes the preview/confirm race where a newly committed
    photo could be deleted unseen.

13. **R2 conditional writes stay, verified by a day-one spike** through both
    the S3 API and Worker bindings. Fallback if the spike fails: route all
    catalog mutations through a single Worker endpoint. *(Amended by #22:
    support confirmed, conflicts surface differently per surface, and tests
    must avoid Miniflare's R2 emulation.)*

14. **"Maintenance mode" dropped as a feature.** With a single admin, "make
    no edits until the restore completes" is a runbook line; conditional
    writes catch violations loudly.

15. **Config cleanup.** The Worker's "allowed Netlify origin" variable was
    removed (image loads carry no Origin/Referer under
    `Referrer-Policy: no-referrer`, so it could never act as access
    control), and `INTERNAL_JOB_KEY` was removed (no Netlify↔Worker calls
    remain). Added: strict CSP (with `'wasm-unsafe-eval'` for the codecs)
    and fully separate display/admin Vite builds.

16. **Validation spike replaced.** The obsolete "verify sharp decodes HEIC on
    Netlify" item became: verify the browser WASM pipeline against
    representative fixtures (48 MP HEIC, EXIF orientation, PNG alpha,
    wide-gamut, malformed) in Chrome, Safari, and Firefox. *(Executed; see
    the amendments below.)*

## Amendments — 2026-08-31 (after day-one spike execution)

An implementation agent executed both day-one spikes against real fixtures
before writing production code. Full results, measurements, and reproduction
notes are in [spike-findings-handoff.md](spike-findings-handoff.md). Three
defects and one open question surfaced; the resulting decisions follow.

17. **HEIF orientation is decode-path dependent.** libheif applies the HEIF
    `irot` property during decode and returns already-upright pixels; Apple
    *additionally* writes a redundant EXIF `Orientation: 6`. Applying EXIF
    orientation on top of libheif's output rotated every portrait HEIC a
    second time, emitting landscape artifacts. The rule: ignore EXIF
    orientation on the libheif path, apply it on the `createImageBitmap` path
    (always passing `imageOrientation: 'none'` explicitly, since the spec
    default has shifted historically and varies by engine). This is recorded
    as a decision rather than an implementation detail because the wrong
    behaviour is *dimensionally self-consistent* — all four artifacts agree
    with one another — so a dimensions-only test passes and the corruption
    ships silently. Only pixel inspection distinguishes them.

18. **EXIF must be parsed with `reviveValues: false` AND
    `translateValues: false`.** Two distinct defects made both necessary.
    Without the first, `exifr` revives `DateTimeOriginal` into a `Date`
    interpreted in the *parsing machine's* timezone, giving a zoneless
    camera-local wall-clock time a spurious instant; for photos taken before
    roughly 08:00 local this shifts the calendar day and files them into the
    wrong day grid — the site's entire navigation structure. Without the
    second, `Orientation` returns as the string `"Rotate 90 CW"` rather than
    `6`, so a numeric test silently skips rotation on exactly the portrait
    photos it exists to correct. Note that design.md was already right here
    ("camera-local calendar date/time is preserved"); it was the obvious
    implementation of it that was wrong.

19. **Display P3 → sRGB conversion is implemented, not skipped.** (Resolves
    the handoff's open question O1.) All of the owner's photos are Display
    P3, and the pipeline as spiked wrote P3 sample values into files
    *labelled* sRGB — reinterpreting rather than converting. Measured
    deviation against ColorSync was small (mean ~1/255 per channel, max 21),
    but the test image was a low-saturation overcast scene and error
    concentrates in saturated pixels, so that figure understates vivid
    subjects. A 3x3 matrix conversion in linear light is roughly 30 lines,
    runs once per photo, and applies to every photo the owner owns; writing
    values that disagree with the profile the file declares is cheaper to fix
    now than after a thousand photos are stored. Amends decision #3: "sRGB
    everywhere" means genuinely converted, not relabelled.

20. **Firefox is unsupported for admin.** It measured 42–45 s per 12.2 MP
    photo (roughly 10x Chromium and WebKit) and crashed the tab on the fourth
    consecutive file, a pattern suggesting memory accumulating across files
    rather than any single image being too large. Root cause was deliberately
    not investigated. This amends the "admin browser is flexible" constraint
    recorded above: admin requires a Chromium-based browser or Safari. **The
    display site is unaffected** — Firefox views the site normally, so the
    viewer support matrix in design.md is unchanged.

21. **Image processing is strictly serial; only uploads are concurrent.** The
    "three files in flight" queue was ambiguous about which stage it governed.
    Three simultaneous large decodes are a memory risk, and Firefox's crash
    pattern shows per-file memory release cannot be assumed. Relatedly, the
    megapixel guard must read dimensions from container/EXIF headers *before*
    full decode, or an oversized file exhausts memory before the check meant
    to prevent exactly that can fire.

22. **Conditional-write testing must not use Miniflare's R2 emulation.**
    Amends decision #13. Both surfaces do support ETag-guarded writes, but
    they fail differently — the S3 API returns HTTP 412 while the Workers
    binding returns `null` without throwing — so a shared retry helper must
    handle both shapes, and a bare `try`/`catch` is wrong on the binding path.
    The retry loop is correct only because R2 is strongly consistent for
    read-after-write; that dependency is now stated in the plan, since moving
    to eventually-consistent storage would break catalog atomicity silently.
    Miniflare has a reported (and closed-as-not-planned) bug inverting
    `onlyIf` semantics, so retry tests run against an in-memory fake with
    explicitly asserted semantics, with live behaviour verified once against a
    real bucket during Phase 1 account setup.

### Smaller corrections

- **Decision #4 (50 MP cap) stands, with an honest justification.** The cap
  was defended by reference to "48 MP iPhones," which the owner does not have
  — the actual devices are 12.2 MP (iPhone 12 Pro, iPad Air 5). A true
  48.8 MP fixture processed in about 12.5 s, so the cap is comfortable; the
  justification is simply forward-looking rather than current.
- **Storage measured.** Roughly 2–5 MB per photo across all four artifacts,
  about 0.9 GB/year at 300 photos/year against R2's 10 GB free tier. The
  full-resolution JPEG is frequently larger than its HEIC source (q92 4:4:4
  versus HEVC); design.md now says so explicitly, so it is not later mistaken
  for a defect.
- **Batch-counter wording reconciled.** The plan had the admin API increment
  a batch counter at begin-batch *and* claimed nothing is persisted before
  commit. Both could not be true: the counter is the sole pre-commit write,
  and an abandoned batch harmlessly leaves a gap in the sequence.
- **GPS stripping verified on real data** — two fixtures carried genuine
  coordinates, and no EXIF or GPS survives in any artifact.
- **Apple's tiled HEIC composites correctly.** libheif returns the full
  composited image from a 48-tile `grid` item, ruling out the most likely
  silent-corruption path.
- **Live R2 verification is not a blocker.** No Cloudflare account exists
  yet, so the R2 conditional-write spike is downgraded from a blocking
  day-one item to a Phase 1 account-setup checklist entry.
