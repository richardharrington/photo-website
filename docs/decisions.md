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
notes were recorded in a spike handoff document, since removed from the
working tree (see #24) and preserved in git history. Three defects and one
open question surfaced; the resulting decisions follow.

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
    the handoff's open question O1; ratified by the owner, see #23.) All
    four spike fixtures were Display P3 — the common case for Apple
    devices — and the pipeline as spiked wrote P3 sample values into files
    *labelled* sRGB — reinterpreting rather than converting. Measured
    deviation against ColorSync was small (mean ~1/255 per channel, max 21),
    but the test image was a low-saturation overcast scene and error
    concentrates in saturated pixels, so that figure understates vivid
    subjects. A 3x3 matrix conversion in linear light is roughly 30 lines,
    runs once per photo, and covers the common Apple case; writing
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
  was defended by reference to "48 MP iPhones," but no such device is known
  to be in play: the 12.2 MP fixtures came from an iPhone 12 Pro and an
  iPad Air 5, and (see the correction under #23–24) they were downloaded
  samples — what the owner's own devices produce is not yet known. A true
  48.8 MP fixture processed in about 12.5 s, so the cap is comfortable
  across the plausible range; the justification is forward-looking rather
  than tied to any particular device.
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

## Amendments — 2026-08-31 (incorporation review)

A follow-up review checked the amendments above against the spike handoff
and found the incorporation faithful; the owner then resolved the items the
review flagged.

23. **O1 resolution ratified.** The owner explicitly approved decision #19:
    Display P3 → sRGB is genuinely converted, not documented away.

24. **The spike handoff document is deleted from the working tree.** Every
    actionable finding is incorporated into the three spec documents, which
    are the single authoritative voice for implementation. A frozen
    narrative copy alongside the living spec would drift stale, re-open
    settled questions (it presents O1 as undecided), and spend the
    implementing agent's context for no benefit. The full report remains in
    git history as `docs/spike-findings-handoff.md`, removed in the same
    commit that records this decision.

### Corrections

- **Fixture provenance.** The spike fixtures were sample photos downloaded
  from the web, not the owner's own photos, and what the owner's iPhone
  typically produces is not yet known. Decision #19 and the 50 MP cap note
  above are reworded accordingly; no measurement changes, but claims about
  "the owner's photos" and "the owner's devices" were unfounded.
- **Untested input class recorded.** No genuine 48 MP iPhone HEIF Max
  capture — Apple's real 48 MP tile structure plus an HDR gain map — was
  ever tested; the 48.8 MP fixture was an upsample. Residual risk is low
  (libheif composited a real 48-tile Apple grid correctly), but the gap is
  now an explicit item in design.md's validation list rather than an
  unrecorded residual risk.
- **Real-Safari manual pass waived by the owner.** The pre-launch manual
  check in real Safari (as opposed to Playwright's WebKit) is dropped;
  automated WebKit coverage is accepted as the extent of Safari
  verification.

## The one-page timeline — 2026-09-01

Reaching a photo took four clicks (year, month, day, photo). The viewer is now
a single scrolling page holding the whole library, and the photo view was
reworked around it. The scope was the viewer alone: no admin, Worker, or
API-contract change beyond one added read route.

25. **All photo metadata arrives in one request at page load.** No batched
    fetching and no scroll spinner. At the design's scale — around 300 photos
    a year — the whole library's metadata is tens of kilobytes now and one to
    two megabytes after a decade, and the images were always the heavy part.
    What this buys is not just simplicity: the metadata carries every
    rendition's pixel dimensions, so the entire page lays out **finally** at
    first paint and never reflows. That is what makes anchor scrolling and
    return-from-photo exact rather than approximate, with nothing to measure,
    retry, or observe. `loading="lazy"` keeps image traffic proportional to
    what is actually scrolled past.

26. **One new read route, `/timeline`; every existing route is unchanged.**
    The admin app consumes `/hierarchy`, `/day`, `/undated`, and the
    `PhotoResponse` shape, so leaving them alone is what keeps this change
    viewer-only. `timelineResponse` is built from the same `liveHierarchy`
    as `hierarchyResponse`, so trash exclusion and every ordering rule come
    along rather than being restated.

27. **The old deep URLs all stay valid and scroll the page to their section.**
    `/2026`, `/2026/03`, `/2026/03/01`, and `/undated` are stable and
    shareable by design; bookmarks keep working. Headings are anchor links
    that `replaceState` to their own route, so a section's URL is copyable
    without scrolling filling the history. Scrolling alone never changes the
    URL — no scrollspy. The browser's own scroll restoration is turned off,
    because it would fight the route's anchor.

28. **A well-formed URL naming a section with no photos is still the site
    404.** `/2026/03/09` on a day with nothing in it shows the same 404 as a
    mistyped address, exactly as the index pages did. An empty **Undated**
    group remains the one exception: it is a fixed part of the page, not a
    section that exists only when populated.

29. **The timeline stays mounted beneath the photo view.** It is rendered as
    a sibling of the lightbox rather than being torn down and rebuilt around
    it, so closing is a reveal at the position the reader left, not a
    re-render. Both read one shared resource, so opening a photo costs one
    request for that photo's own detail and nothing else.

30. **Arrow navigation traverses the whole library, not one day.** Dated
    photos day by day, then undated; the arrows disable only at the two
    global ends. This is the core "less clicking" request, and it needs no
    API change now that the client holds the whole ordered list. Neighbours
    are still resolved from `window.location` at press time rather than from
    a captured render, which is what keeps a held-down arrow key advancing
    (see #21's sibling defect in the earlier lightbox). After the current
    photo renders, both neighbours' `display-1280` renditions are prefetched.

31. **Closing the photo view returns to the photo's own tile, not the day's
    heading.** After arrowing deep into a long day, landing on the heading
    would mean finding the photo again by eye. It is a one-shot request in
    module state, consumed by the timeline on its next render, deliberately
    not a `location.hash` — a hash is part of the URL people copy, and this
    is a transient detail of one navigation.

32. **The photo view lost its chrome.** No header bar, no rules, and no
    "3 of 24" — a position in a list of thousands says nothing. The way back
    sits top-left and reads "← Lightbox", static text: it follows the photo
    currently shown, so a label naming the day would rewrite itself under the
    cursor on every arrow press. Bottom-left is one stack — caption, date,
    **Download**, **Photo info** — and the photo's box runs exactly between
    that stack's bottom and the back link. The caption and date are plain text
    sharing the buttons' right edge, not bordered surfaces; a button-looking
    caption invites a click that does nothing. That shared edge sits a fixed
    20px short of the picture, which takes a measurement: the picture is
    centred inside an `img` box stretched to the space available, so its
    visible left edge follows from the aspect ratio and the window, and no
    stylesheet can name it. The component publishes it as `--photo-left`; the
    stack's left edge stays at the page margin, so a picture wide enough to
    leave no room wraps the caption instead of pushing it off screen. Clock
    time, filename, and
    dimensions stay in the panel one click away, which is positioned out of
    flow so opening it cannot shove that shared edge sideways. Below the 40rem
    breakpoint the whole lot becomes a slim footer row under the photo
    instead: a portrait photo spans a phone's full width, so anything floating
    over it would need a scrim and would cover the photograph.

33. **No virtualization.** Every image in the library is in the DOM, and that
    is deliberate at this scale. Virtualizing would trade exact anchors and
    exact back-navigation for a problem this library does not have.

34. **A table of contents or jump-to-date side nav is deferred, not
    rejected.** The pinned year and month headings and the anchor routes are
    its foundation; building it is a later project.

35. **Grid selection is modifier-click and shift-click, and nothing else.**
    Marquee dragging was specified, built, and removed: a plain click opens the
    detail panel, so a drag that began on a tile could never be told from a
    click, and the selection it was supposed to feed stayed permanently empty.
    Command-click (Control elsewhere) to toggle one photo and Shift-click to
    reach back to the last one toggled are the gestures every file manager
    already teaches, they need no empty space to start in, and they reach the
    same actions. Masonry runs top to bottom within a column, so a shift-range
    is not always the rectangle it looks like; the selected tiles say plainly
    what it caught, which is enough. A shift-click adds to the selection rather
    than replacing it, so it can never take away a photo picked out by hand,
    and the anchor stays where it was so several shift-clicks in a row all
    measure from the same tile. An unmodified click clears the selection as
    well as opening the panel, which is what makes that safe to be additive:
    a range that caught too much is always one plain click from being started
    over. That click still leaves its own tile as the anchor, so shift-clicking
    after it reaches back to the photo on screen in the panel — without that,
    the commonest gesture of all (click one, shift-click another) found no
    anchor and selected a single tile, which is what a modifier-click does.
    A second selected photo closes the panel: it speaks for one photograph,
    and it would be describing the wrong one.

36. **"Delete this whole group" became "Select all" plus "Delete selected".**
    One button that deletes everything on the page is a wide blast radius
    reached in a single click, and it could not express "all but these two".
    Select all reaches the same photos in one click and shows what it caught
    before anything destructive is offered. Every bulk action still resolves
    through the same preview/confirm token path (#12), now with an explicit ID
    list rather than a group query. The cost is that emptying a whole month is
    now a day at a time.

    The toolbar row — Delete selected, Select all, Deselect all — never shows a
    disabled button. Each is present exactly when it has something to act on
    and absent otherwise, and the row is right-aligned so the survivors close
    the gap. A greyed-out button asks the reader to work out why it is dead;
    an absent one asks nothing. Select all and Deselect all are two buttons
    rather than one that renames itself, because a control whose label changes
    under the cursor has to be re-read before every click.
