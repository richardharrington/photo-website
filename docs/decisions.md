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
    A second marked photo closes the panel: it speaks for one photograph, and
    it would be describing the wrong one. The photo the panel is open on counts
    as marked, so a modifier-click on any other tile is already two — without
    that the panel stayed put through the commonest case of all, one open and
    one picked out beside it.

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

37. **The enlarged photo is a layer, not a page.** Deciding whether to delete a
    photograph often needs more than a thumbnail and a 24rem preview, but the
    decision is made against the panel's own date, caption, and Delete button —
    so the bigger picture opens over the admin rather than navigating away
    from it, and closes back onto exactly the state it was opened from. It
    renders inside the panel, which already holds a stacking context, so one
    `z-index: 1` puts it over the panel and the grid alike with no competing
    numbers elsewhere in the stylesheet. The box around the picture shrinks to
    the picture, which is what lets the [x] hang on the photograph's own corner
    instead of a letterboxed box's, and makes every pixel that is not the
    photograph part of the backdrop that closes it. Escape closes the topmost
    thing only: the enlarged photo first, the panel once there is nothing over
    it, and while it is open a click outside is its business rather than a
    click outside the panel.

## The admin becomes the viewer — 2026-09-03

The viewer became the better way to reach a photograph — one scroll, arrow
keys across the whole library — while the admin stayed four clicks deep and
had drifted into a second implementation of the same hierarchy. The admin is
now the viewer plus curation. What the family sees does not change at all: the
first stage was a pure refactor with an identical rendered viewer, and the
second adds nothing to the display bundle but a few branches.

38. **Two builds, one UI library.** The viewer's pages, components, routes,
    scroll, and read client moved to `src/shared/ui/`, which both apps import;
    `src/display/` and `src/admin/` keep an entry, an `App`, an API client,
    and an `index.html`. Rejected: leaving the code in `src/display/` and
    having the admin import it, because the display build's root would then
    double as the admin's component library, and the one-directional "display
    never imports admin" rule would have to be policed by reading. With a
    shared tree the rule is symmetric and greppable: nothing under
    `src/shared/` names `src/display` or `src/admin`. The two Vite builds, the
    two opaque paths, the gate, and both Functions are untouched.

39. **Curation is a React context.** `src/shared/ui/curation.ts` exports a
    `CurationContext` whose value is `null` in the viewer and a typed object
    in the admin; shared components check for its presence and read callbacks
    from it. Nothing in the shared tree imports admin code — the context
    carries nothing the viewer could not compile against — so the viewer ships
    the branches and never the modules, at about 5 kB. Rejected: render props
    and slots, which is prop threading by another name, and assembling each
    page from smaller pieces, which would have meant two page layouts to keep
    in step.

40. **A plain click on a tile opens the photo view, in both apps, and the
    admin's editing lives there.** The side detail panel, its enlarged-preview
    overlay, the admin grid, and the level-by-level browse are gone. This
    supersedes #37: the photo view *is* the enlarged view, so there is no
    layer over a panel to close in order.

41. **The photo view's bottom-left stack holds the edit form, always.** Where
    the viewer shows caption and date as text, the admin shows capture date,
    capture time, and caption as fields with **Save changes**, and beneath
    them **Download**, **Delete**, **Photo info**. No Edit toggle: editing is
    what an administrator is there for, and a toggle puts a click in front of
    every correction. The form needs room a caption does not, so under
    curation the stage starts clear of a fixed gutter and the picture centres
    in what is left — the stack takes that gutter outright rather than hanging
    off `--photo-left` as the viewer's does (#32), because the previous-photo
    button sits exactly where a stack measured from the picture would end.

42. **Explicit Save, and an unsaved edit is discarded silently** on arrow
    navigation, Escape, and close, exactly as the old panel discarded it. The
    form is keyed on the photo's ID, so arrowing remounts it with the stored
    values; keying on the metadata too would remount it the moment a save came
    back and wipe the "Saved" mark the user was meant to see.

43. **Fields own the keyboard while focused.** With focus inside the form,
    ArrowLeft, ArrowRight, Delete, Backspace, and Escape do what they do in a
    text field, and the photo view's handlers ignore them; Escape blurs the
    field, and a second Escape closes the view. This is a correctness rule,
    not a preference: the handler is on `window`, so without it an arrow would
    change photo while the caret was meant to move and Backspace would delete
    the photograph instead of a character. The same handler stands down
    entirely when something outside the dialog holds focus, which is how the
    confirmation dialog stops Escape from cancelling it *and* closing the view
    behind it.

44. **Delete advances.** After a photo is trashed from the photo view, the
    view moves to the next photo in library order, or the previous one if it
    was last, or closes if the library is now empty. Triage of a bad day is
    Delete, confirm, Delete, confirm. The next photo is computed from the
    order *before* the patch, which is the only place the trashed photo's
    neighbours are still written down, and the navigation is a `replace`, so
    Back does not land on a photo that is a 404 now.

45. **Every delete is confirmed, single or bulk,** through the existing
    preview/confirm token dialog (#12); Enter confirms, because the dialog
    focuses its own confirm button. Delete and Backspace are keyboard
    shortcuts for it in the photo view, subject to #43. Rejected: skipping the
    dialog for single deletes with Undo as the only net — the dialog states
    the resolved count, and a resolved count is the thing worth reading.

46. **The Undo offer lasts five seconds and nothing else retires it.** Not
    arrowing, not closing the photo view, not clicking a heading. This
    replaces the admin's old "any navigation retires the offer" rule, because
    #44 makes advancing after a delete a navigation, and the rule would have
    withdrawn the offer before it could be read. A second deletion inside
    those five seconds replaces the banner with a fresh one for its own
    photos, keyed by what it would put back so it inherits no clock.

47. **Selection spans the whole library.** One selection for the page, and a
    shift-range runs across day, month, and year boundaries in timeline order,
    from the same index the arrows step through. It is not keyed to a route,
    so the headings' `replaceState` navigation leaves it alone.

48. **Select all moved from the toolbar to each day heading, and the toolbar
    became a sticky bar.** This amends #36. There is no library-wide Select
    all — one click that marks a decade for deletion is a blast radius, and
    the day is the unit the page is already organised by — and a day's control
    *adds* to the selection rather than replacing it, so two days is two
    clicks. While anything is selected a bar pinned to the top of the viewport
    shows the count, **Delete selected**, and **Deselect all**; with nothing
    selected there is no bar. #36's "never a disabled button" rule still
    holds for both: the day's control is absent once its whole day is
    selected, and returns when one photo is deselected. The bar measures
    itself and publishes its height to the root, because the pinned year and
    month headings have to move down out from under it and it wraps on a
    narrow window — a number written in two places is a number that
    disagrees with itself.

    This also amends #35: a plain click now opens the photo view rather than a
    panel, and "a second marked photo closes the panel" no longer applies,
    there being no panel. Everything else in #35 stands, the plain-clicked
    tile still being the anchor.

49. **After a mutation the admin patches the timeline in memory from the
    server's reply, then refetches in the background.** Immediate UI, one
    source of truth a moment later, and at most one refetch in flight. The
    patch functions are pure and unit-tested against the same counts-agree
    invariant the projection guarantees, because a patch that broke it would
    put the page into a state the server could never produce — an empty day
    heading, or a count that disagrees with the tiles under it. `upsertPhoto`
    cannot place a *date-only* photo exactly: those are ordered by
    `(batchSeq, selectionIndex)` and a `PublicPhoto` deliberately carries
    neither, so it lands after the day's timed photos and the refetch settles
    it. Restore has no patch at all — the restored photo is not in the
    response the client holds — and an upload batch only refetches.

50. **`/hierarchy`, `/day`, and `/undated` are gone from both Functions, the
    fixture server, and the shared projection.** This supersedes #26, whose
    whole reason for keeping them was that the admin still browsed level by
    level. `/timeline` and `/photo` are the only read projections now. They
    return `null` from the shared route table rather than a 404, so a stale
    client asking for one gets the same plain 404 as any other unknown path.

51. **The trash is the same grid and the same photo view, read-only.** Its
    listing gained a signed `display-1280` preview URL alongside the
    thumbnail, so the photo view has something to show; `full` is never signed
    for a trashed photo and there is no download of any kind. Its photo view
    is local state rather than a route, because a trashed photo's
    `/photo/<id>` is a 404 by design — which is also why its tiles are buttons
    rather than links, there being no address to link to.

52. **Two stages, shipped separately.** The first moved the viewer into
    `src/shared/ui/` with no behaviour change, verified by the display and
    mobile suites passing unchanged. The second replaced the admin on top of
    it. Splitting them is what made "the viewer did not change" a claim a test
    run could settle rather than a claim about a diff.

## Curating photographs as they arrive — 2026-09-03

Three changes to the admin, made together because they are one complaint: the
administrator was waiting on the machine. Numbering continues from above.

53. **The drop target is pinned to the top of the page, and is a bar rather
    than a panel.** The library is one scrolling page years long, so a target
    at the head of it is a target you have to scroll back to — with a file
    already held over the window, which is the one moment a scroll is hardest
    to perform. It is sticky rather than fixed, and a direct child of the main
    column, so it pins for the whole scroll and still takes its own space at
    the top; that is why the panel emits it as a sibling of the arrivals area
    rather than wrapping both in a section, since a wrapper would end the
    sticky containing block at the top of the page.

    The cost is vertical room, paid on every screen: it is a slim bar once
    there is a library, and keeps the large panel only while there is not.
    It publishes its measured height to the root as `--drop-target-height`,
    joining `--selection-bar-height` in the offset the pinned year and month
    headings use — measured, not declared, because it wraps on a narrow
    window. It stands down entirely while a photo view is open, its own
    included: one photograph fills the screen there, and a target pinned over
    it would be inviting a drop onto a view that is not the library.

54. **A dropped file is a photograph on the page before it is one on the
    server.** Waiting for four encodes and four PUTs before the first
    correction can be made is most of the time it takes to curate a batch, and
    a batch off a camera is a batch of wrong dates. So a queued file is
    projected into a `PublicPhoto` (`src/admin/upload/pending.ts`) and
    rendered by the same grid and the same photo view as the library, in an
    arrivals area above it — the trash's pattern exactly, and for the same
    reason: there is no catalog record and so no address, which is why the
    tiles are buttons and the view is local state.

    Three consequences worth writing down:

    - **Every dropped file's EXIF is read up front**, before the serial
      processing loop reaches it, so the tile whose date most needs correcting
      is not the one that has no date for a minute. It is a header parse, not
      a decode, so it does not violate the serial rule in #21. The result is
      handed back to `processFile` rather than parsed twice, which makes the
      date shown and the date committed one value rather than two expected to
      agree.
    - **What is typed goes into that file's own commit** when the file has not
      committed yet, and to the stored photo when it has. The difference is
      meant to be invisible, and the only moment the queue refuses is while
      the commit is actually in flight — the body is built by then and cannot
      be amended, and saying so leaves the edit in the form rather than losing
      it or claiming to have stored it. A typed date that differs from the
      extracted one commits `timestampSource: 'manual'`, the same rule
      `editPhoto` applies.
    - **The picture appears from memory.** The thumbnail and the 1280 are held
      as object URLs from the moment the encoders produce them, so the tile
      stops being a grey rectangle well before the PUTs finish. Roughly a
      quarter of a megabyte a photograph, released when the item is cleared.
      Until then the tile reserves a 3:2 rectangle, which is a guess and has
      to be: the true shape is known only after the decode that orientation is
      applied in.

    The arrivals area clears itself once the batch has settled *and* the
    library has been reloaded — never before, or the photographs would blink
    out of existence between the two — and never while one of those very
    photographs is open, which would unmount the photo view and take the edit
    being typed in it along. Failures and duplicates stay behind, being the
    only rows that say something the library does not.

55. **`Curation.readOnly` became `Curation.can`, three explicit
    capabilities.** The three listings that provide a context do not differ
    along one axis: the library allows editing, downloading and trashing; the
    trash allows none of them; a photograph still uploading allows editing and
    nothing else, having no stored bytes to download and no record to trash.
    A single flag cannot say that, and the alternative — a second photo view
    for arrivals — would be the thing this whole change exists to avoid.

56. **An unsaved edit disables the arrows.** Stepping to another photograph
    remounts the form on that one's stored values, which is exactly how the
    edit gets discarded, so the two arrow buttons and both arrow keys refuse
    while the form differs from what is stored. Escape and closing still leave
    and still discard: those are asking to go. The form is what says why —
    "Unsaved changes" beside Save — because a disabled button cannot be
    hovered for a tooltip on every platform and cannot be focused for a label.

    Dirtiness is a comparison against the record, not a flag: typing a
    character and deleting it again leaves nothing behind, and a save clears
    it by arithmetic as soon as the stored photo comes back. Which is why the
    form now takes the caption back from what was stored as well as the date
    and time — a caption is stored trimmed, and without that the fields still
    read as unsaved after a successful save.

## Noticing a photograph, not finding one — 2026-09-04

The site's whole navigation structure is capture date, which is right for
finding a photograph and useless for noticing one. A family member who visits
monthly currently has no way to learn that anything is new unless it was also
shot recently — a box of scanned 1978 prints arrives and lands at the bottom
of the page under a 1978 heading. `/recent` is a second view of the same one
response, and everything about it is additive: the library page, its anchors,
its ordering, and its URLs are unchanged.

57. **Recency is a property of the photographs, not of the viewer.** The set
    is decided on the server from `createdAt`: the 50 newest, everything
    inside 14 days, and every photograph sharing an upload batch with either.
    Computing it in the browser would judge the window by the reader's own
    clock, so a machine with a wrong date would see a different library, and
    unreproducibly. The floor keeps a quiet month from looking empty; the
    window keeps a heavy fortnight from being truncated; the batch closure
    keeps one upload from being shown cut in half.

    There is deliberately **no ceiling**. If the fiftieth newest photograph
    lands inside an 800-photograph import, all 800 are in, and on the day the
    library is first filled `/recent` is the whole library until the window
    rolls past the import. Both are accepted: a rule with an exception has an
    edge, and the edge is where it will be wrong.

    `PublicPhoto` gains neither `createdAt` nor `batchSeq`. The projection was
    written to withhold upload bookkeeping, and under this design the client
    needs none of it — membership, grouping, ordering and the capture span are
    all decided in `src/shared/display-api.ts`, which is a pure function of a
    catalog and a moment. `timelineResponse` therefore takes `nowMs` rather
    than reading the clock, threaded from `readRoute` exactly as `now` is
    threaded through the mutation path.

58. **The server groups without a calendar; the browser labels with one.**
    `createdAt` is a genuine instant, and an instant has no calendar day until
    you choose a place to stand. The viewers of this site are scattered across
    zones and none of them is the uploader, so there is no such place. The
    server therefore splits arrivals wherever more than six hours passes
    between two of them and names each group by its newest instant; the
    browser turns that instant into "Added yesterday" in the reader's own
    zone.

    Rejected: grouping by UTC calendar day, which files an 8pm Pacific upload
    under tomorrow; by a configured site timezone, which names the uploader's
    day to readers who are not in it and adds an environment variable of
    exactly the shape that trips Netlify's secrets scanner; and by the
    viewer's own zone in the browser, which moves the recency rule client-side
    and makes the same upload one group for one cousin and two for another,
    with nothing on screen explaining why.

    `batchSeq` is deliberately not the grouping key. A batch is one admin page
    session, so it spans days when the tab is left open and splits when the
    page is reloaded mid-sitting. Neither boundary is visible or meaningful to
    the family; it keeps its job in the batch-closure rule and nowhere else.

59. **The subtitle is suppressed only for an exact same-day match, and that
    one judgement is made in the browser.** It compares a capture date against
    a calendar day, and the server has no calendar — so it lives beside the
    labelling code and uses the same reader-zone day the heading is derived
    from, which is what keeps the two from ever disagreeing.

    A consequence worth understanding rather than fixing: an evening upload
    can be same-day for the uploader and the day before for a cousin further
    east, so she sees the subtitle and he does not. That is correct in both
    frames — to her, these *are* photographs from the day before they
    appeared. The server always sends the capture range and the undated count;
    only the rendering varies.

    Nothing weaker than strict equality suppresses. A weekend uploaded on
    Monday still prints "photographs from September 1–3, 2026", which is
    redundant-ish but true; the alternative was a second, unrelated use of the
    14-day window and a cliff at its edge. For the same reason a span inside
    one month always prints its days, however many.

60. **Upload sittings have no addresses.** Group headings are plain text and
    there is no `/recent/<date>`. A link to one sitting stops meaning anything
    as soon as that sitting ages out of the set, and a URL that silently
    becomes a 404 is worse than no URL. `/recent` itself is stable, which is
    the link that matters — "come look at what I just put up".

    `/recent/photo/<id>` is stable for the same reason a photo's own URL is:
    it names the photograph, not its place. A live photograph that has since
    aged out of the set still opens from such a link. It is simply absent from
    the ordered list the arrows step through, so both are disabled and closing
    lands at the top of `/recent`. Nothing redirects and nothing 404s.

61. **`orderedIds` is view-dependent.** The admin's shift-range, its advance
    after a delete, and the pruning that keeps a bulk action honest all take
    one ordered list, and it has to be the order actually on screen. In
    `/recent` that is the concatenation of the groups' own ids, not the
    library's display order. Getting this wrong fails *silently* — a
    shift-range would quietly pick up photographs scattered across years and
    look as though it had worked — which is why it has a test of its own built
    on a catalog where the two orders disagree.

    For the same reason the two listings are never in the DOM together: a
    tile's element id is document-unique, and both the anchor scroll and the
    close-the-photo-view scroll depend on it resolving to exactly one element.
    That is what ruled out a "recently uploaded" band above the timeline.

62. **An edit does not touch `recent`; a delete does.** `upsertPhoto` was
    built on `removePhotos` — remove, then reinsert into the year tree — so
    once `removePhotos` learned to drop ids from the upload sittings, an edit
    would have made the photograph vanish from `/recent` until the refetch.
    The year-tree removal is now its own function, and only the delete path
    patches the sittings. A group's capture range and the photograph's
    position within it may be briefly stale after an edit; none of the three
    is navigation, and the refetch is immediate.

63. **Two scrolling defects the recent view surfaced, both fixed underneath
    it.** Neither is about recency; both were latent in code the library has
    used since the one-page timeline, and both would have made "close the
    photograph and land back on its tile" wrong.

    The lightbox locks the page behind it by setting `overflow: hidden` on the
    body, and it did so in a passive effect. A passive cleanup runs *after*
    every layout effect in the same commit, and the listing underneath asks
    for its scroll in a layout effect — so closing scrolled while the body was
    still locked, which WebKit answers by going to the bottom of the page. It
    is a layout effect now, so the lock is released in the mutation phase,
    before anything tries to scroll.

    `scrollToElementId` handed the work to `scrollIntoView`. WebKit gets that
    wrong for an element inside a multi-column container taller than the
    viewport, scrolling to the bottom of the document as though it were
    measuring in the flow rather than in the painted fragment. Every day's
    grid in the library is short enough to stay clear of it; one upload
    sitting can be an 800-photo import, so `/recent` meets it on its first
    tile. The position is computed from `getBoundingClientRect` and the
    element's own `scroll-margin-top` instead, which keeps the CSS the only
    place that offset is written down and is correct in every engine.
