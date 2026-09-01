# Infinite-scroll design overhaul

Implementation plan for replacing the viewer's click-down hierarchy
(years → months → days → day grid) with a single scrolling timeline page, and
for reworking the single-photo view. Written to be implemented by someone with
no other context beyond this repo; read `CLAUDE.md` first, and treat the
Decisions table below as settled — each entry was chosen deliberately, with
alternatives considered.

**Scope: the viewer app only.** Nothing here touches `worker/`, `src/admin/`,
or any existing API route. Deploy is Netlify-only (push to `master`); no
`wrangler deploy` is needed.

## Motivation

Reaching any photo today takes four clicks (year → month → day → photo). The
overhaul shows everything on one page: year headers, month headers below them,
day headers below those, and a masonry block of photos under each day — the
whole library scrollable top to bottom, newest first, exactly the structure
the current index pages describe but with no navigation between levels.

## Decisions (settled — do not relitigate)

| # | Question | Decision | Why |
|---|----------|----------|-----|
| 1 | Data loading | All photo metadata in one request at page load; no batched fetching, no scroll spinner | At the design's scale (~300 photos/year, `docs/design.md`) the whole library's metadata is tens of KB now, ~1–2 MB after a decade. Metadata includes every rendition's pixel dimensions, so the entire page lays out **finally** at first paint and never reflows — which is what makes anchors and back-navigation exact. Images were always the heavy part, and `loading="lazy"` already fetches only what is scrolled toward. |
| 2 | API | One new read route, `/timeline`; `/hierarchy`, `/day`, `/undated`, `/photo`, `/download` unchanged | The admin app consumes the existing routes and `PhotoResponse` shape (`src/admin/api.ts`); leaving them untouched keeps this change viewer-only. |
| 3 | Old deep URLs | `/2026`, `/2026/03`, `/2026/03/01`, `/undated` all stay valid and render the timeline scrolled to that section | Deep URLs are stable and shareable by design (`src/display/routes.ts` header comment); old bookmarks keep working. |
| 4 | Photo view | The timeline stays mounted (invisibly) beneath the opaque lightbox, as the day grid does today | Closing the lightbox is an instant reveal at the correct scroll position, no re-render or jump. Same mechanism as today's `PhotoPage`. |
| 5 | Undated group | Last section on the page, after the oldest year; `/undated` anchors to it | Same end-of-list placement it has today. |
| 6 | URL while scrolling | Year/month/day headers are anchor links: clicking one does `history.replaceState` to its route. Scrolling alone never changes the URL | Shareable links to any section with minimal machinery; no scrollspy. |
| 7 | Return from photo view | Back link / Escape scrolls the timeline so the **photo's own tile** is in view | After arrowing deep into a long day, returning to the day header would mean re-finding the photo by eye. |
| 8 | Photo view chrome | No header bar, no rules, no "N of M" count, no visible date line. Back link top-left; photo top-aligned with it. "Download" stacked above "Photo info", bottom-left; photo bottom-aligned with the Photo info button. Caption (when present) stays visible; date/filename/dimensions move into the Photo info overlay | Frees vertical space for the photo. Captions are the only hand-written content and stay visible; EXIF-ish details are one click away. |
| 9 | Photo view on mobile | Narrow screens keep a slim footer row below the photo (two compact buttons side by side) instead of overlaying buttons on the image | Buttons floating over the image need a scrim and cover the photo; a portrait photo on a phone spans the full width. |
| 10 | Sticky headers | Current year **and** month pin at the top while scrolling (`position: sticky`, stacked offsets) | Context on a page holding years of photos; also the natural seed for a future jump-to-date nav. |
| 11 | Arrow navigation | Lightbox arrows traverse the **whole library** in display order (dated photos day by day, then undated); arrows disable only at the global ends | The core "less clicking" request. Needs no API change — see §4. |
| 12 | Preloading | After the current photo renders, prefetch the previous and next photos' `display-1280` renditions | Rapid arrowing hits a warm cache. |
| 13 | Nonexistent sections | A well-formed route matching no section (e.g. `/2026/03/09` when that day has no photos) renders the site 404 | Preserves today's behavior (`MissingGroup`) and the design rule that a mistyped URL shows a 404, not an empty group. |
| 14 | Table of contents / side nav | **Deferred.** Do not build one | Sticky headers + anchor routes are its foundation; a later project. |

## 1. API: the `/timeline` route

### Projection (`src/shared/display-api.ts`)

Add types and a projection alongside the existing ones. The shape is the
hierarchy plus photos:

```ts
export interface TimelineDay {
  day: number;
  count: number;
  photos: PublicPhoto[];
}
export interface TimelineMonth {
  month: number;
  count: number;
  days: TimelineDay[];
}
export interface TimelineYear {
  year: number;
  count: number;
  months: TimelineMonth[];
}
export interface TimelineResponse {
  title: string;
  years: TimelineYear[];
  undated: { count: number; photos: PublicPhoto[] };
  total: number;
}

export function timelineResponse(catalog: Catalog, title: string): TimelineResponse
```

Implement it exactly like `hierarchyResponse` (same `liveHierarchy` →
`buildHierarchy` path, so trashed photos are excluded and all ordering rules —
newest-first years/months/days, time-of-day order within a day, upload order
for undated — come along for free), mapping each `DayGroup.photos` and the
undated list through `toPublicPhoto`.

Constraints:

- `src/shared/display-api.ts` compiles under all three tsconfigs; no DOM,
  Node, or Workers globals.
- `PublicPhoto` deliberately omits `contentHash`, `batchSeq`,
  `selectionIndex`. Do not add fields.

### Serving it — two places, not one

1. **`netlify/functions/lib/read-routes.ts`** — add to `readRoute()`:

   ```ts
   if (path === '/timeline') {
     return json(timelineResponse(catalog, process.env.SITE_TITLE ?? 'Family Photos'));
   }
   ```

   Both Netlify functions call `readRoute`, so display and admin APIs both
   serve it (harmless and consistent for admin).

2. **`config/fixture-server.ts`** — `handleDisplay()` (~line 181) does **not**
   call `readRoute`; it re-implements each display GET inline. Add a
   `/timeline` branch there mirroring its `/hierarchy` branch. CLAUDE.md
   documents this exact drift trap ("when adding a route, add it to the real
   function, not just the fixture server") — do the real function first.

### Client (`src/display/api.ts`)

```ts
timeline: (signal?: AbortSignal) => getJson<TimelineResponse>('/timeline', signal),
```

After this change the viewer no longer calls `hierarchy`, `day`, or `undated`;
remove those client methods (the server routes stay for admin). `photo` and
`downloadLink` remain.

## 2. Routing and `App.tsx`

`src/display/routes.ts` is unchanged — every existing route shape survives,
including its malformed-URL-→ `not-found` behavior.

Rewrite `App.tsx`:

```
home / year / month / day / undated → <TimelinePage target={...} />
photo                               → <PhotoPage id={route.id} />  (renders TimelinePage beneath, §4)
not-found                           → 404 as today
```

`target` is a discriminated union derived from the route
(`{kind:'top'} | {kind:'year',...} | {kind:'month',...} | {kind:'day',...} |
{kind:'undated'}`).

Scroll handling replaces `useScrollToTopOnChange`: on route change, `home`
scrolls to top; year/month/day/undated scroll to their anchor **after the
timeline data is ready** (layout is final at that point, so a plain
`scrollIntoView` / `scrollTo` with the sticky-header offset is exact); `photo`
routes must not reset scroll (same rule as today's `App.tsx:13-15`). Returning
from a photo scrolls to the tile (§4). Header-click navigation uses
`replace: true` (`navigate(to, { replace: true })` in
`src/shared/ui/navigation.ts`) so scrolling around doesn't pile up history
entries; a `popstate` back/forward should re-run the anchor scroll.

## 3. `TimelinePage`

New file `src/display/pages/TimelinePage.tsx`. Delete
`src/display/pages/HierarchyPages.tsx` and `src/display/pages/GroupPage.tsx`,
and the now-unused `GroupList`/`GroupEntry` exports in
`src/display/components/Layout.tsx`. `Layout` itself (site title header) stays
and wraps the timeline.

Structure:

- Fetch via `useResource<TimelineResponse>` once. `loading` / `error` /
  `not-found` states reuse `Loading` / `ErrorState` / `NotFound` exactly as
  `HierarchyGate` does today. Empty library (`total === 0` and no undated) →
  `Empty`.
- For each year: a year header (`2026`), then for each month: a month header
  (`December` + count), then for each day: a day header (`December 31` +
  count) followed by `<PhotoGrid photos={day.photos} />`. `PhotoGrid` is
  reused unchanged (masonry CSS columns, lazy thumbnails, width/height
  attributes).
- Day header labels are month-name + day (`December 31`), **not** the full
  `formatCaptureDate` form — the year is already the enclosing header. Use
  `monthName(month)` from `src/shared/datetime.ts`. Month headers use
  `monthName`; counts formatted like today's `photoCount` ("N photo(s)").
- Undated: final section, header `Undated` + count, only when
  `undated.count > 0` (same rule as today's years list) — but if the route
  target is `undated` and the count is 0, still render the section header with
  the existing "No undated photos." empty text rather than 404ing, matching
  today's `UndatedPage`.
- Headers are anchor links: an `<a>` with the real route href
  (`routes.year(...)` etc.) whose click handler calls
  `navigate(href, { replace: true })` — copyable/middle-clickable like
  `useLinkProps`, but replace-not-push.

Anchors and ids:

```
year   → id="y-2026"
month  → id="m-2026-12"     (two-digit month)
day    → id="d-2026-12-31"  (two-digit month and day)
undated→ id="undated"
tile   → id="photo-<32-hex id>"  (on the <li> in PhotoGrid — add an id prop or derive it there)
```

Sticky headers (CSS in `src/shared/styles/display.css`):

- Year header: `position: sticky; top: 0`.
- Month header: `position: sticky; top: <year header height>`.
- Both need an opaque `background: var(--bg)` and a `z-index` above the
  images. Use fixed heights (or CSS variables) for the two header rows so the
  stacked `top` offsets and the anchor-scroll offset share one source of
  truth. Anchor scrolling must account for the stuck headers —
  `scroll-margin-top` on the section elements is the cleanest mechanism.
- Keep the restrained visual style: neutral surfaces, system type. Headers
  should look like today's index-page headings, scaled to rank (year largest).

Scale note: this renders every `<img>` in the library into the DOM
(thousands eventually). That is deliberate and fine at this site's scale —
lazy loading keeps network cost proportional to scrolling. Do **not** add
virtualization.

## 4. Photo view rework

### Data flow (`src/display/pages/PhotoPage.tsx`)

Keep the current two-resource pattern but swap the group fetch for the
timeline:

- `detail` — `displayApi.photo(id)` with `keepPreviousData`, exactly as
  today. Still needed: it is the fast first response on a direct `/photo/<id>`
  landing, and its `previousId`/`nextId` are the stand-in neighbors until the
  timeline arrives.
- `timeline` — `displayApi.timeline()` with `keepPreviousData` (one fetch; it
  does not depend on the detail response, so fire both immediately).

From the timeline, build (memoized):

- `orderedIds`: every photo ID flattened in display order — years → months →
  days → photos, then undated photos. This is the global list handed to the
  lightbox; the existing `orderedIds` mechanism in `Lightbox.tsx` (resolve
  position from `window.location` at press time) is what keeps rapid arrowing
  correct and must be preserved, comment and all.
- `dayOf(id)`: map from photo ID → its `GroupRef`-like section (year/month/day
  or undated), for the back link.

Until the timeline is ready, `orderedIds` falls back to
`[detail.previousId, id, detail.nextId].filter(Boolean)` — the same fallback
shape the current code uses when the group hasn't loaded. The group-scoped
`index`/`total` from `PhotoResponse` are no longer displayed (the count is
removed) but the API keeps returning them for admin.

The photo shown is the timeline's copy when available, else
`detail.data.photo` (same "known" pattern as today).

Beneath the lightbox, render the timeline page itself (the full
`<TimelinePage>` UI, sharing the fetched resource — lift the resource into
`PhotoPage` or give `TimelinePage` an optional pre-fetched prop) so that
closing reveals it already mounted. Body scroll remains locked while the
lightbox is open (existing effect in `Lightbox`).

### Back link and close behavior

- Label: `← Back to <formatCaptureDate(day)>` (e.g. "Back to March 1, 2026"),
  or "Back to Undated". Derived from the **currently shown** photo, so it
  changes whenever arrowing crosses a day boundary.
- Href: the day route (`routes.day(...)` / `routes.undated()`) — copyable and
  correct on its own.
- Activation (click or Escape): `navigate` to that day route, then scroll the
  timeline so the **tile** `#photo-<id>` is in view (respecting
  `scroll-margin-top` for the sticky headers). Implement as a one-shot
  "pending scroll target" (module-level or context), consumed by
  `TimelinePage` after render; it wins over the route's own day-header anchor
  for that one navigation. Do not use `location.hash`.

### Layout (`src/display/components/Lightbox.tsx` + CSS)

Desktop/tablet:

- Remove `.lightbox__bar` (and its bottom border) and `.lightbox__position`
  ("N of M") entirely. The back link floats at the top-left corner of the
  page, in the flow-free sense: the photo's top edge aligns with the top of
  the back link (both start at the same page padding from the top).
- Remove `.lightbox__details` as a footer band (top border, date line gone).
- Bottom-left: a vertical stack — **Download** button on top, **Photo info**
  button below it, left-aligned, bottom-aligned to the same page padding. The
  photo's bottom edge aligns with the bottom of the Photo info button. So the
  photo's vertical box runs from the back-link's top to the button stack's
  bottom; horizontally it centers in the remaining space and may sit beside
  the corner elements. Arrow buttons stay vertically centered at the left and
  right edges as today.
- Button labels change: "Download original size" → **"Download"** (in-flight
  label "Preparing download…" may stay); "Photo information" →
  **"Photo info"**.
- Caption (when non-null) stays visible: a small muted line near the bottom,
  to the right of the button stack, `white-space: pre-wrap` preserved. No
  capture date/time line anywhere outside the info panel.
- Photo info opens as an **overlay panel** (popover-style card above the
  button stack, over the photo, `z-index` above the image, scrollable if
  tall) containing the existing `<dl>`: original filename, capture date/time
  (the removed visible line moves here), camera UTC offset when present,
  full-size dimensions. Keep `aria-expanded`/`aria-controls`. The download
  error line renders adjacent to the buttons with `role="alert"` as today.
- Keyboard handling, focus management, dialog semantics, and the
  `history`-based `step()` logic are unchanged.

Mobile (reuse/extend the existing narrow-screen breakpoint conventions in
`display.css`; the grid uses `@media (min-width: 40rem)`):

- Below the breakpoint, no overlays on the image: photo on top, then a slim
  footer row with the two buttons side by side (compact), caption below or
  beside them, no rules. The back link stays at the top-left above the photo.

### Preloading

In `Lightbox` (or `PhotoPage`), an effect keyed on the current photo ID: look
up the previous and next IDs in `orderedIds` and create `new Image()` with
`derivativeUrl(__WORKER_BASE_URL__, neighborId, 'display-1280')` for each.
Fire after the current image has rendered (e.g. from its `onLoad`, falling
back to effect timing). No `<link rel=preload>` — plain `Image()` is enough
and needs no header changes.

## 5. Tests

Unit (Vitest, Node env):

- `tests/unit/read-routes.test.ts`: `/timeline` returns 200 with the full
  shape; still `null` for unknown paths.
- New or extended projection tests (pattern: existing `ordering.test.ts` /
  `read-routes.test.ts`): `timelineResponse` excludes trashed photos, orders
  years/months/days newest-first, orders photos within a day by capture time
  then upload order, puts undated last, counts match, `PublicPhoto` fields
  only (assert `contentHash` absent).

E2E (`tests/e2e/display.spec.ts`, plus `mobile.spec.ts` for the mobile photo
footer). The existing specs test the click-down hierarchy and the old
lightbox chrome ("Back to August 2, 2026" close flow, `.lightbox__caption`,
rendition assertions) — rewrite around:

- Landing on the base path shows year, month, and day headers and photo
  grids all on one page.
- `/2026/03/01`-style routes land scrolled to that day (assert the day header
  is within the viewport); nonexistent-but-well-formed sections show the 404.
- Clicking a header updates the URL (replaceState) to that route.
- Opening a photo, arrowing across a day boundary, and checking the back
  label changed; arrows disabled at the global first/last photo.
- Closing the photo view returns with the photo's tile in the viewport.
- "Download" and "Photo info" labels; info overlay contains the capture
  date; no "N of M" text; caption visible when present.
- Thumbnails request `thumb`, lightbox requests `display-1280`/`display-2560`
  (keep the existing rendition test, adjusted).

The e2e fixtures come from the fixture server (placeholder SVGs, seeded
catalog) — no `sample-photos/` needed; those skip-if-absent rules apply only
to `pipeline.spec.ts`.

Run `npm run check` (format, lint, all three tsconfigs, unit tests) and
`npm run test:e2e` (chromium, webkit, mobile-safari — Playwright starts the
dev servers itself).

## 6. Cleanup checklist

- Delete `HierarchyPages.tsx`, `GroupPage.tsx`; remove `GroupList`/
  `GroupEntry` from `Layout.tsx`; remove `hierarchy`/`day`/`undated` from
  `src/display/api.ts`; remove `useScrollToTopOnChange` if nothing else uses
  it (check `src/admin/` first — it imports from the same shared module).
- Remove dead CSS: `.group-list*`, `.lightbox__bar`, `.lightbox__position`,
  `.lightbox__capture`, breadcrumb styles if breadcrumbs become unused
  (`Layout` crumbs are still used by… check: after this change the viewer may
  never pass `crumbs`; if so, trim, but `Layout` is display-only — admin has
  its own chrome — so verify with a grep before deleting shared-looking
  styles: `admin.css` vs `display.css`).
- Update `docs/design.md` (navigation section: one-page timeline replaces
  index pages) and `docs/decisions.md` (append the Decisions table above,
  in its numbered style, with the scale rationale for all-metadata-up-front).

## Out of scope

- Table of contents / jump-to-date side nav (deferred; sticky headers and
  anchor routes are its foundation).
- Scrollspy URL tracking.
- Virtualized rendering.
- Any admin app, Worker, or API-contract change beyond adding `/timeline`.
