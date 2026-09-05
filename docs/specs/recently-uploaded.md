# The Recently Uploaded view

Spec, 2026-09-04. Written after a design interview; the decisions below are
settled unless marked "implementer's discretion". A separate agent implements
this. Where this spec and the code disagree, the spec wins; where it and
`docs/design.md` disagree, the spec wins and the doc is updated (section 13).

## 1. Outcome

Both apps gain a second listing at `/recent`, reached by a toggle beside the
site title. It shows photographs by **when they arrived**, not when they were
taken, so a box of scanned 1978 prints is visible as new instead of sitting at
the bottom of a newest-first page under a 1978 heading.

The library view does not change: same page, same anchors, same ordering, same
URLs. Everything here is additive.

Reason: the site's whole navigation structure is capture date, which is right
for finding a photograph and useless for noticing one. A family member who
visits monthly currently has no way to learn that anything is new unless it
was also shot recently.

## 2. The recent set

Over live (non-trashed) photos only — `livePhotos(catalog)` — the set is the
union of three rules:

- **(a) A floor.** The 50 newest by `createdAt`, so the view is never thin.
- **(b) A window.** Everything with `createdAt` inside the last 14 days, so a
  heavy fortnight is never truncated.
- **(c) Batch closure.** Every photo sharing a `batchSeq` with anything in
  (a) ∪ (b), so an upload is never shown cut in half.

Formally, with `L = livePhotos(catalog)`:

```
A  = first 50 of L ordered by (createdAt desc, id desc)
B  = { p ∈ L : nowMs − Date.parse(p.createdAt) < 14 days }
S₀ = A ∪ B
S  = { p ∈ L : p.batchSeq ∈ { q.batchSeq : q ∈ S₀ } }
```

Notes:

- `(createdAt desc, id desc)` is a **total** order. `createdAt` is per-photo
  (each commit stamps its own request's `now`, `admin-operations.ts:102`), so
  ties are near-impossible, but the tiebreak is required for reproducible
  tests and stable pagination-free rendering.
- One closure pass is enough: sharing a `batchSeq` is an equivalence relation,
  so `S` is already closed.
- `S` has **no ceiling**. If the 50th newest photo lands inside an 800-photo
  batch, all 800 are in. On the day the library is first filled, `S` is the
  whole library until the window rolls past the import. Both are accepted.
- Trashed photos are excluded at every stage, including from the closure: a
  batch's trashed members do not come back.

Constants go in `src/shared/constants.ts` beside `TRASH_RETENTION_DAYS`:
`RECENT_FLOOR = 50`, `RECENT_WINDOW_DAYS = 14`, `RECENT_GAP_HOURS = 6`.

## 3. Grouping — sittings, not days

Photographs in `S` are grouped by **when they were uploaded**, but *not* by
calendar day. `createdAt` is a genuine instant and an instant has no calendar
day until you choose a place to stand — and the viewers of this site are
scattered across zones and differ from the uploader, so there is no such place.

So the server groups **without a calendar** and the browser labels **with the
reader's own**:

1. Order `S` by `createdAt` descending.
2. Start a new group wherever more than `RECENT_GAP_HOURS` (6) passes between
   consecutive photographs.
3. A group's identifying instant is the **newest** `createdAt` in it — the
   moment after which the group was complete, which keeps "Added today" true
   for a sitting that began at 11:50pm the night before.

`batchSeq` is deliberately **not** the grouping key. A batch is one admin page
session (`UploadQueue` assigns it lazily at first commit and never resets it,
`src/admin/upload/queue.ts:405`), so it can span days if the tab is left open,
and it splits if the page is reloaded mid-sitting. Neither boundary is visible
or meaningful to the family. `batchSeq` keeps its job in rule (c) only.

Rejected: grouping by UTC calendar day (an 8pm Pacific upload heads a group
dated tomorrow); by a configured site timezone (names the uploader's day to
readers who are not in it, and adds an env var of exactly the shape that trips
Netlify's secrets scanner); by the viewer's own zone in the browser (moves the
recency rule client-side, and the same upload becomes one group for one cousin
and two for another, with nothing on screen explaining why).

## 4. Ordering

- **Groups**: newest first.
- **Within a group**: capture order, newest capture first — the same rule the
  rest of the site follows, so a viewer has already learned it. Dated
  photographs first in descending capture-date order; within one capture date
  delegate to the existing `comparePhotosWithinDay` (timed photos in clock
  order, then date-only in upload order); undated photographs last, ordered by
  `compareUploadOrder`.

This needs one new comparator in `src/shared/ordering.ts`. It is capture
order *across* dates, which the existing hierarchy never needed because days
were the container.

Rejected: arrival order — drop order is invisible to the family, and
`selectionIndex` is not unique within a batch anyway (`add()` takes
`offset = this.items.length`, `queue.ts:191`, and `clearCommitted()` shrinks
that list once a sitting settles), so it degrades to a photo-ID tiebreak.

## 5. API contract

`TimelineResponse` gains one field. The photographs themselves are **not**
repeated — groups carry ids, which the client resolves against the map
`indexTimeline` already builds.

```ts
export interface RecentGroup {
  /**
   * ISO-8601 UTC instant: the newest createdAt in the group. The server never
   * names a calendar day; the browser formats this in the reader's own zone.
   */
  uploadedAt: string;
  count: number;
  /** Capture span of the dated photographs. Null when all are undated. */
  captureRange: { earliest: CaptureDate; latest: CaptureDate } | null;
  undatedCount: number;
  /** The group's photo IDs, in display order (section 4). */
  photoIds: string[];
}

export interface TimelineResponse {
  // ...unchanged...
  /** Newest group first. Empty only when the library is empty. */
  recent: RecentGroup[];
}
```

Invariant worth asserting in a test: every id in `recent` also appears in
`years` or `undated`, since both projections derive from `livePhotos`.

`PublicPhoto` does **not** gain `createdAt` or `batchSeq`. The projection was
written to withhold upload bookkeeping, and under this design the client never
needs it — membership, grouping, ordering and the capture range are all
decided server-side, in `src/shared/display-api.ts`, by pure functions
testable against `fixtures/in-memory-store.ts`.

`timelineResponse(catalog, title)` gains a `nowMs` argument for rule (b). It
must not read the clock itself; the two Functions, the Worker and the fixture
server pass it, exactly as `now` is threaded through the mutation path today.

Rejected: a separate `/api/recent` route (a round trip on a site whose entire
page is one request, and the same photo arriving from two endpoints); full
`PublicPhoto` objects inside the groups (a duplicate of every recent photo,
and two objects per photo that must not disagree); client-side computation of
the rule (the 14-day window would be judged by the viewer's own clock, so a
machine with a wrong date would see a different library, unreproducibly).

## 6. Routing

Two new routes, parsed unconditionally for both apps — unlike `trash`, there
is no app-specific vocabulary here:

```ts
| { kind: 'recent' }                      //  /recent
| { kind: 'recent-photo'; id: string }    //  /recent/photo/<id>
```

Parse `recent` alongside `undated` and `photo`, before the `extra` check and
before the year parse. `/recent` alone is `recent`; `/recent/photo/<id>` with
a valid ID is `recent-photo`; anything else under `/recent` is `not-found`.
`ADMIN_PAGES` stays `['trash']`.

The nested form is why `parseRoute` changes rather than gaining a list entry:
`extra` matches single-segment pages only (`segments.length === 1`,
`routes.ts:71`).

`appRoutes` in `src/shared/urls.ts` gains `recent()` and `recentPhoto(id)`.

Deep links **within** `/recent` are deliberately absent: group headings are
plain text, not links, and there is no `/recent/<date>`. A link to one upload
sitting stops meaning anything as soon as that sitting ages out of the set,
and a URL that silently becomes a 404 is worse than no URL. `/recent` itself
is stable and shareable, which is the link that matters ("come look at what I
just put up").

## 7. The page

Rendered by a new shared component, `src/shared/ui/RecentPage.tsx`, alongside
`TimelinePage`. Same `Layout`, same `PhotoGrid`, same tiles.

Each group renders:

- **A heading**, the top-level heading of this page, carrying the time and a
  count in the existing `.timeline__count` treatment:
  `Added yesterday · 63 photos`. `design.md` withholds counts from day
  headings because a day's photographs are all on screen beneath it; that is
  not true here, where one sitting can be an 800-photo import.
- **A subtitle line** naming the capture span, present unless the group is
  entirely photographs captured on the day it was uploaded (section 8).
- **The grid**, one `PhotoGrid` per group.

Empty `/recent` renders the `Empty` state, never a 404 — it is a fixed part of
the site like the Undated section, not a section that exists only if populated.
With the 50-photo floor this occurs only when the library itself is empty.

## 8. Wording

**The heading's time**, computed in the browser from `uploadedAt` in the
reader's own zone: relative for the past week — "Added today", "Added
yesterday", "Added Tuesday" — and absolute beyond it: "Added 21 August".
Include the year when it is not the current one.

Staleness is accepted: a page left open overnight says "Added today" about
yesterday until it is reloaded. Implementer's discretion whether to recompute
on `visibilitychange`.

**The subtitle**, computed from `captureRange` and `undatedCount`, at the
coarsest granularity that fits:

| Case | Line |
| --- | --- |
| One capture date | `photographs from August 2, 2026` |
| One month | `photographs from August 2026` |
| One year, several months | `photographs from March–August 1978` |
| Several years | `photographs from March 1977 – August 1978` |
| Any undated present | append `, and 4 undated` |
| All undated (`captureRange` null) | `undated photographs` |

**Same-day suppression.** The subtitle is omitted when it would only restate
the heading — that is, when all of:

- `undatedCount === 0`, and
- `captureRange !== null` and `earliest === latest`, and
- that date is the calendar date of `uploadedAt` **in the reader's own zone**.

So a sitting of photographs shot and uploaded the same day is one clean
heading and a grid; everything else carries its span. Nothing weaker than
strict equality suppresses: a weekend uploaded on Monday still prints
"photographs from September 1–3, 2026", which is redundant-ish but true, and
the alternative was a second, unrelated use of the 14-day window and a cliff
at its edge.

**The suppression is decided in the browser, not the server** — it compares a
capture date against a calendar day, and the server has no calendar (section
3). It therefore belongs beside the labelling code, using the same reader-zone
day the heading is derived from. A consequence worth understanding rather than
fixing: an evening upload can be same-day for the uploader and the day before
for a cousin further east, so she sees the subtitle and he does not. That is
correct in both frames — to her, these *are* photographs from the day before
they appeared. The server always sends `captureRange` and `undatedCount`; only
the rendering varies.

Reuse `formatCaptureDate` and `formatMonth` from `src/shared/datetime.ts`.
Capture dates are `YYYY-MM-DD` strings, so min/max is string comparison — do
not parse them into `Date`.

## 9. The photo view

`/recent/photo/<id>` is fully symmetric with `/photo/<id>`: the recent view
renders underneath and stays mounted, the lightbox opens over it, arrows
traverse **the recent set in its own order**, and closing returns to the tile
in `/recent` that was left.

Two shared components gain a prop, both defaulting to today's behaviour:

- `Lightbox` takes `photoHref?: (id: string) => string`. It currently
  hardcodes `routes.photo(target)` when stepping (`Lightbox.tsx:148`), which
  would silently drop a reader out of `/recent` on the first arrow press.
- `PhotoPage` takes the ordered id list and `backHref` from its caller rather
  than always deriving them from `indexTimeline`.

The detail response's `group`, `index`, `total`, `previousId` and `nextId`
stay library-oriented and are unused here; `PhotoPage` already prefers the
client's ordered list over the detail response's neighbours, for the reason
given in its own comment.

## 10. The toggle, and the unseen marker

Both labels are always visible; the current view is plain text with
`aria-current="page"`, the other is a link. It lives in `Layout`'s existing
`nav` slot — the viewer passes it, and the admin puts it beside Trash and
Export catalog.

**Placement differs by width, deliberately.**

- Below 40rem: the header stays in normal flow, as today. It scrolls away;
  the site title already does.
- At 40rem and above: the header is sticky, so the toggle is reachable from
  anywhere in a page years long.

**The unseen marker.** The browser stores the newest `uploadedAt` it has
rendered on `/recent` (`localStorage`, one key). When the timeline response
carries a `recent[0].uploadedAt` newer than the stored value, the toggle shows
a marker — a dot or bolder weight, implementer's discretion — which clears
when `/recent` is opened.

This is **emphasis only**. It never affects set membership, so it is safe for
it to be absent or wrong: wrap every read and write in `try`/`catch` (private
windows throw), and render no marker when storage is unavailable. Nothing
about the recency rule becomes per-device.

Rejected: a total count on the toggle (the 50-photo floor pins it near the
same number forever, so it carries no signal); an unseen *count* (needs a
per-device diff that goes wrong after a delete, for a number nobody acts on
differently than a dot).

## 11. Layout and styles

- `--layout-header-height` joins `--timeline-year-height` and
  `--timeline-month-height` as a **constant**, defined at `:root` inside
  `@media (min-width: 40rem)` and `0px` below it, so the calculations collapse
  on phones. The header gets that fixed height at that width and its nav must
  not wrap there.
- Inside the same media query: `.timeline__year-heading` pins at
  `top: var(--layout-header-height)`, `.timeline__month-heading` at the sum of
  header and year, and `--timeline-stack-height` becomes all three. The header
  needs a `z-index` above both.
- A fixed height rather than a measured one, on purpose: the year and month
  heights are already constants precisely so that the sticky offsets and the
  anchor `scroll-margin` can agree without measuring. A fourth, measured term
  would put a `ResizeObserver` in shared `Layout` whose result must land
  before the anchor scroll runs — the ordering hazard the comment at
  `Upload.tsx:135` exists to warn about.
- `.layout__nav`, `.layout__nav a`, and `.layout__header:has(.layout__nav)`
  move from `admin.css` to the shared stylesheet: the viewer uses that slot now.
- `PhotoGrid`'s `note` prop is **not** used by this feature. Tiles in
  `/recent` look exactly like tiles in the library.

## 12. Admin behaviour

`/recent` in the admin is the family's page plus full curation: selection,
shift-range, Select all on each group heading, edit, trash — everything the
library allows.

The one thing that must change is the ordered list the selection reasons about.
`orderedIds` is `indexTimeline(data).orderedIds` today (`src/admin/App.tsx:127`)
— **library** display order. On a recent route it must instead be the
concatenation of `recent[].photoIds` in order, so that:

- `extendTo(visible, orderedIds, id)` selects the run a shift-click actually
  spans on screen;
- `nextAfterDeleting(orderedIds, …)` advances to the neighbour the reader can
  see;
- `pruneToVisible` prunes against what is on the page.

Both already take `orderedIds` as an argument, so this is a substitution, not
a rewiring. Getting this wrong fails *silently* — a shift-range would quietly
pick up photographs scattered across years and look as though it worked — so
it deserves a test of its own.

Also:

- After trashing from `/recent/photo/<id>`, navigate to
  `routes.recentPhoto(next)`, or `routes.recent()` when nothing follows.
- `removePhotos` in `src/shared/timeline-patch.ts` must patch `recent` too:
  drop the ids, fix each group's `count` and `undatedCount`, and drop a group
  that empties.
- `upsertPhoto` patches the photo itself; a group's `captureRange` may be
  stale until the background refetch lands a moment later. Accepted — the
  refetch is immediate and the range is a subtitle, not navigation.
- Newly uploaded photographs do not appear in `recent` until the refetch,
  which the upload panel already awaits before clearing its tiles.
- The pinned upload target stays on `/recent`; it is chrome, not part of the
  library listing.

## 13. Traps in the code

Things that will bite an implementer who has not read the surrounding files.

- **`tileAnchor(id)` is a document-unique element id** (`photo-<id>`), and
  both `scrollToElementId` and the close-the-lightbox `requestScrollTo` depend
  on it resolving to exactly one element. Never render the library and the
  recent view into the DOM at the same time. This is why "a Recently Uploaded
  band above the timeline" was rejected outright.
- **Add the read route in `netlify/functions/lib/read-routes.ts`**, which both
  Functions share — not only to the fixture server. The fixture server's admin
  handler still falls through to `handleDisplay` for unrecognized GETs, which
  once hid the admin API missing the viewer's read routes entirely
  (`CLAUDE.md`, "Local development fake").
- **`src/shared/` outside `ui/` and `styles/` must stay free of DOM, Node and
  Workers globals** — it compiles into all three targets, and
  `npm run typecheck` runs three tsconfigs. The grouping and range code lives
  there; the *labelling* code, which needs `Intl` and the reader's zone, lives
  in `src/shared/ui/`.
- **`src/shared/` must not import from either app**, and nothing in the
  display module graph may import from `src/admin/`. `RecentPage` belongs in
  `src/shared/ui/`; its admin behaviour arrives through `CurationContext`,
  exactly as `TimelinePage`'s does.
- **Capture dates are strings and stay strings.** `Date` is for `createdAt`
  only. Comparing, min-ing and max-ing `YYYY-MM-DD` is string work.
- **Both refusal paths stay a plain 404.** `/recent/photo/<id>` for a trashed
  or unknown photo is the same generic 404 as `/photo/<id>`.

## 14. Tests

- **The set rule**, against `fixtures/in-memory-store.ts`: the floor alone;
  the window alone; the window exceeding the floor; batch closure pulling in
  photos older than both; a trashed member of an included batch staying out;
  the exact 14-day boundary; determinism of the `(createdAt, id)` order.
- **Grouping**: a gap of exactly `RECENT_GAP_HOURS` (state which side of the
  boundary opens a new group and test it); a sitting split across a reload
  staying one group; two sittings a day apart being two.
- **The range**, one test per row of the table in section 8, including the
  all-undated and mixed cases.
- **Same-day suppression**, with a fixed clock and an explicit zone: a
  single-capture-date group uploaded that same day renders no subtitle; the
  same group read from a zone where the upload falls on the next day renders
  one. Also assert that a lone undated photograph in an otherwise same-day
  group keeps the subtitle.
- **Ordering**: capture-descending across dates, timed-before-date-only within
  a date, undated last.
- **The labeller** (`@vitest-environment happy-dom`): today, yesterday,
  within-week, older, and a previous year, with a fixed clock.
- **Admin selection**: a shift-range in `/recent` selects the photographs
  between the two clicked *in recent order*, and a range that would differ in
  library order is the case to assert.
- **Playwright**: toggle to `/recent`, open a photograph, arrow twice, close,
  and land back on the tile in `/recent`; the unseen marker appearing and
  clearing.

## 15. Documentation

- `docs/design.md`, "Display site": the two views and the toggle, the recency
  rule in prose, the grouping-by-sitting rule, and the responsive header.
- `docs/decisions.md`: why recency is a photo property and not a per-viewer
  one; why the server groups without a calendar and the browser labels with
  one; why the subtitle is suppressed only for an exact same-day match, and
  why that one judgement is made in the browser; why upload sittings have no
  addresses; why `orderedIds` is view-dependent.
- `docs/implementation-plan.md`: the new route, component, projection field
  and constants.

## 16. Deliberately not decided

- The exact marker (dot vs weight) on the toggle.
- Whether the label recomputes on `visibilitychange`.
- Which side of the 6-hour boundary opens a new group — pick one and test it.
- The real value of `--layout-header-height`.
