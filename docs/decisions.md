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

4. **Source cap lowered from 100 MP to 50 MP** (50 MB unchanged). Covers all
   current phones (48 MP iPhone); halves worst-case decode memory in the
   browser. The check is natural client-side since the browser decodes
   anyway (the old plan's browser-side check was impossible for HEIC in
   Chrome/Firefox).

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
    catalog mutations through a single Worker endpoint.

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
    wide-gamut, malformed) in Chrome, Safari, and Firefox.
