# Merging the admin site into the viewer

Spec, 2026-09-03. Written after a design interview; the decisions below are
settled unless marked "implementer's discretion". A separate agent implements
this. Where this spec and the code disagree, the spec wins; where it and
`docs/design.md` disagree, the spec wins and the doc is updated (section 7).

## 1. Outcome

The admin site becomes the viewer site plus curation. Same one-page timeline,
same lightbox, same URLs below its own opaque base, with editing, deletion,
selection, upload, and Trash layered on. The level-by-level admin browse, the
side detail panel, its enlarged-preview overlay, and the admin grid are
removed. The two Vite builds, the two opaque paths, the gate, and both
Functions stay exactly as they are.

Reasons: the viewer is now the better way to reach a photo (one scroll, arrow
keys across the whole library), and the admin was four clicks deep and had
drifted into a second implementation of the same hierarchy.

What the family sees does not change at all. Stage 1 is a pure refactor of the
viewer with an identical rendered result, and stage 2 adds nothing to the
display bundle.

## 2. Decisions

Numbered so the implementation and the docs can cite them.

1. **Two builds, one UI library.** The viewer's pages, components, routes,
   scroll, and stylesheet move to `src/shared/ui/`. Both apps import from
   there. `src/display/` and `src/admin/` keep only an entry, an `App`, an
   API client, and `index.html`. Rejected: leaving the code in `src/display/`
   and having admin import it, because the display build's root would then
   double as the admin's component library and the one-directional
   "display never imports admin" rule would have to be policed by reading.
   With a shared tree the rule is symmetric and greppable: nothing under
   `src/shared/` imports from `src/display/` or `src/admin/`.

2. **Curation is a React context.** `src/shared/ui/` exports a
   `CurationContext` whose value is `null` in the viewer and a typed object in
   the admin (section 4.9). Shared components check for presence and read
   callbacks from it. Nothing in `src/shared/ui/` imports admin code; the
   admin provides the value. The viewer bundle carries the branches but never
   the admin modules. Rejected: render props and slots (chosen against for
   prop threading), and assembling each page from smaller pieces.

3. **A plain click on a tile opens the lightbox** in both apps. The admin's
   editing lives in the lightbox. There is no side panel and no separate
   enlarged-preview layer: the lightbox is the enlarged preview.

4. **The admin lightbox's bottom-left stack holds the edit form**, always.
   Where the viewer shows caption and date as text, the admin shows the
   capture date, capture time, and caption fields with a Save button. Below
   that, the action row: Download, Delete, Photo info. There is no Edit
   toggle.

5. **Explicit Save.** Nothing is sent until Save. An unsaved edit is
   discarded silently on arrow navigation, Escape, and close, exactly as the
   old panel discarded it.

6. **Fields own the keyboard while focused.** With focus inside any field of
   the form, ArrowLeft, ArrowRight, Delete, Backspace, and Escape do what they
   do in a text field; the lightbox's handlers ignore them. Escape inside a
   field blurs it. A second Escape, with focus outside the form, closes the
   lightbox. This is a correctness rule, not a preference: the current
   lightbox binds arrows on `window` and would change photo while the caret
   moves.

7. **Delete advances.** After a photo is trashed from the lightbox, the
   lightbox moves to the next photo in library order, or the previous one if
   it was last, or closes to the timeline if it was the only photo. Triage of
   a bad day is Delete, confirm, Delete, confirm.

8. **Every delete is confirmed**, single or bulk, through the existing
   preview/confirm token dialog (decisions.md #12). Enter confirms. Rejected:
   skipping the dialog for single deletes with Undo as the only net.

9. **Delete and Backspace are keyboard shortcuts for Delete** in the admin
   lightbox, subject to rule 6. They open the same confirmation dialog the
   button does, and call `preventDefault`.

10. **The Undo offer lasts five seconds and nothing else retires it.** Not
    arrowing, not closing the lightbox, not clicking a heading. A second
    deletion inside those five seconds replaces the banner with a fresh one
    for its own photos. This replaces the admin's current "any navigation
    retires the offer" rule, because advancing after a delete is itself a
    navigation.

11. **Selection spans the whole library.** One selection for the page; a
    shift-range runs across day, month, and year boundaries in timeline
    order. The selection is not keyed to a route and survives the heading
    links' `replaceState` navigation.

12. **A plain click clears the selection**, as today. Modifier-click toggles
    one photo; shift-click extends from the anchor; the tile plain-clicked
    becomes the anchor. Marquee dragging stays absent (decisions.md #35).

13. **A sticky bar, and Select all on each day heading.** While anything is
    selected, a bar pinned to the top of the viewport shows the count,
    **Delete selected**, and **Deselect all**. With nothing selected the bar
    is absent. Select all moves from the toolbar to the day heading: each day
    carries a **Select all** control that adds that day's photos to the
    selection, shown only while at least one of them is unselected. There is
    no library-wide Select all. decisions.md #36's "never a disabled button"
    rule still applies to both the bar and the heading control.

14. **Upload stays above the timeline**, always present, prominent when the
    library is empty. The queue renders beneath it. Unchanged from today.

15. **Trash stays its own route**, `/trash`, linked from the header with its
    count. The page is rebuilt on the shared grid and lightbox: trashed tiles
    in the same masonry, a read-only lightbox for identification, restore and
    permanent delete on a sticky bar.

16. **The trash listing gains a signed preview URL.** Each item carries
    `thumbnailUrl` and `previewUrl` (the `display-1280` rendition), both
    short-lived, so the trash lightbox has something to show. The function
    never signs `full` for a trashed photo.

17. **Admin tiles show the original filename** beneath every thumbnail. The
    viewer's tiles never do.

18. **The admin header is the viewer's header plus Trash (count) and Export
    catalog**, styled to match.

19. **Reads through one shared client; each app adds its own writes.**
    `src/shared/ui/api.ts` exports the read client (timeline, photo,
    download link) built on `appRoutes(__APP_BASE__)`. The admin client wraps
    it and adds the mutations, keeping its richer error parsing.

20. **After a mutation the admin patches the timeline in memory from the
    response, then refetches in the background.** Immediate UI, one source of
    truth a moment later. The patch functions are pure and unit-tested. An
    upload batch only refetches.

21. **`/hierarchy`, `/day`, and `/undated` are removed** from both Functions,
    the fixture server, `src/shared/display-api.ts`, and their tests, in
    stage 2. Nothing will call them.

22. **Two stages.** Stage 1 moves the viewer into `src/shared/ui/` with no
    behaviour change and ships. Stage 2 replaces the admin on top of it.

23. **Admin remains laptop-oriented.** Below the lightbox's 40rem breakpoint
    the edit form renders in the footer row the viewer already uses, and it
    must be usable, but touch selection stays out of scope (design.md).

## 3. Stage 1: extract the shared UI

A refactor with a byte-for-byte identical viewer. The e2e display suite must
pass unchanged before and after.

### 3.1 Moves

From `src/display/` to `src/shared/ui/`:

| From                          | To                                   |
| ----------------------------- | ------------------------------------ |
| `routes.ts`                   | `ui/routes.ts`                       |
| `scroll.ts`                   | `ui/scroll.ts`                       |
| `components/Layout.tsx`       | `ui/Layout.tsx`                      |
| `components/States.tsx`       | `ui/States.tsx`                      |
| `components/PhotoGrid.tsx`    | `ui/PhotoGrid.tsx`                   |
| `components/Lightbox.tsx`     | `ui/Lightbox.tsx`                    |
| `pages/TimelinePage.tsx`      | `ui/TimelinePage.tsx`                |
| `pages/PhotoPage.tsx`         | `ui/PhotoPage.tsx`                   |
| `api.ts` (reads only)         | `ui/api.ts`                          |

Subdirectories inside `ui/` are implementer's discretion; a flat directory of
about fifteen files is acceptable. `src/shared/styles/display.css` stays where
it is. Any unit test that imports a moved file moves its import.

`src/display/` afterwards holds `index.html`, `main.tsx`, `App.tsx`, and
nothing else. `App.tsx` is the current file with its imports repointed.

### 3.2 Decoupling

Every moved component currently imports `routes` and `displayApi` from
`src/display/api.ts`. After the move:

- `ui/api.ts` exports `routes = appRoutes(__APP_BASE__)` and the read client,
  named `readApi`, with `timeline`, `photo`, and `downloadLink`. Because
  `__APP_BASE__` is a build-time define, this resolves to each build's own
  base and needs no injection. Its 404 handling (`NotFoundError`) is kept.
- `Layout` takes an optional `nav` prop (`ReactNode`) rendered in the header
  after the site title. The viewer passes nothing. This is the one shared
  component that changes shape in stage 1, so that stage 2 has somewhere to
  put Trash and Export without touching the viewer again.
- `TimelinePage` takes an optional `above` prop (`ReactNode`) rendered inside
  `Layout` before the timeline, for the upload panel. Viewer passes nothing.
- `CurationContext` is created in stage 1 with the type from section 4.9 and
  a `null` default. No component reads it yet. It exists so stage 2 does not
  have to touch every file a second time to add the import.

### 3.3 Rules that must hold after the move

- `grep -rn "src/display\|src/admin\|'\.\./\.\./display\|'\.\./\.\./admin" src/shared` finds nothing.
- The display build's output contains no string from `src/admin/` (the
  existing e2e test "serves no admin path or admin code from the display
  build" covers this and must keep passing).
- `npm run check` passes; the three tsconfigs already exclude
  `src/shared/ui/**` from the Functions and Worker builds, so nothing there
  needs changing.

### 3.4 Acceptance

`npm run test:e2e --project=chromium` on `display.spec.ts` and
`mobile.spec.ts` passes; `admin.spec.ts` passes unchanged (the admin still
runs its old code in stage 1).

## 4. Stage 2: the new admin

### 4.1 Routes

`src/shared/ui/routes.ts` gains an `extra` parameter: a list of top-level
segments that parse to `{ kind: 'page'; name: string }` when they appear
alone. The viewer passes none. The admin passes `['trash']`. Everything else
in the parser is shared. `AdminRoute` is `Route | { kind: 'page'; name:
'trash' }`. `src/admin/routes.ts` is deleted.

Admin routes:

| Path                     | Renders                                            |
| ------------------------ | -------------------------------------------------- |
| `/`, `/YYYY`, `/YYYY/MM`, `/YYYY/MM/DD`, `/undated` | The timeline, scrolled as the viewer does, with upload above |
| `/photo/<id>`            | Timeline beneath, admin lightbox over it            |
| `/trash`                 | The trash page                                     |
| anything else            | The shared 404                                     |

### 4.2 App shape

`src/admin/App.tsx` is rewritten. It owns:

- the timeline resource (`readApi.timeline`) plus a local patched copy and the
  background refetch (4.6);
- the selection state (`src/admin/selection.ts` is kept and gains
  `addAll(state, ids)`, which unions rather than replaces as the existing
  `selectAll` does; the existing tests stay and `addAll` gets its own);
- the confirmation preview (`Confirm.tsx` is kept);
- the undo offer (`UndoBanner` is kept; the retire-on-navigation rule in
  `App.tsx` is dropped);
- the trash count resource for the header;
- an app-level error line, as today.

It provides `CurationContext` and renders `TimelinePage`, `PhotoPage`, the
sticky bar, the confirm dialog, and the undo banner. Its `Layout` nav is the
Trash link with count and the Export link.

Deleted: `src/admin/components/AdminGrid.tsx`, `DetailPanel.tsx`,
`TrashView.tsx`, `src/admin/routes.ts`, and every part of
`src/shared/styles/admin.css` that styled them (sections "Admin grid",
"Detail panel", "Enlarged photo", "Trash"). Kept: `Upload.tsx`,
`upload/queue.ts`, `Confirm.tsx`, `selection.ts`, `api.ts` (now wrapping
`readApi`, with `hierarchy`, `day`, and `undated` removed).

### 4.3 Header

The viewer's header with `nav` filled: `Trash (n)` and `Export catalog`,
right-aligned, in that order. The site title is the link to the top exactly
as in the viewer. There is no "Administration" suffix on the title; the URL
already says which site this is, and the nav says the rest.

### 4.4 Upload

`UploadPanel` is rendered through `TimelinePage`'s `above` slot, with
`emphasized` when the timeline's `total` and undated count are both zero. On
batch completion the app refetches the timeline (4.6). No other change.

### 4.5 The timeline

**Tiles.** `PhotoGrid` renders each tile as a `Link` to the photo route in
both apps. With a curation context present:

- the tile also renders the original filename beneath the image, in the
  style the admin grid used;
- `onClick` inspects modifiers: shift calls `curation.extendTo(id)`; meta or
  ctrl calls `curation.toggle(id)`; either way it calls `preventDefault` so
  the browser does not open a tab. A plain click calls
  `curation.anchorOn(id)` (which also clears the selection) and lets the
  link navigate;
- the tile carries `data-photo-id`, `data-selected`, and the selected class
  the admin grid used, so the same wash-and-border styling applies.

**Selection order.** `extendTo` needs the library's ordered ID list. The app
computes it once per timeline from the same index `PhotoPage` builds
(`indexTimeline`), which moves to `src/shared/ui/timeline-index.ts` and is
exported. Undated photos come last, as in navigation.

**Pruning.** The selection is pruned to the IDs present in the current
(patched) timeline on every render, as `GridView` does today. A bulk delete
acts only on the pruned set.

**Sticky bar.** Rendered by the admin app, fixed to the top of the viewport
beneath the header, only while the pruned selection is non-empty. Contents,
left to right: "n selected", **Delete selected**, **Deselect all**. Delete
selected calls `previewTrash({ kind: 'ids', photoIds })`; the existing
dialog follows. The bar must not cover the pinned year and month headings
in a way that hides them: it sits above them in stacking order and the
headings' `top` offset accounts for its height while it is shown
(implementer's discretion on the mechanism; a CSS variable set on the root
while the bar is present is one way).

**Select all on the day heading.** With a curation context present,
`TimelinePage` renders a small **Select all** button at the right end of each
day heading, outside the heading's anchor link so it does not navigate. It is
present only while at least one photo in that day is not selected, and
absent otherwise (it never renders disabled). Clicking it calls
`curation.selectAll(ids)` with that day's photo IDs, which adds them to the
selection without removing anything already selected, and sets no anchor. The
Undated group gets the same control. The trash page's single heading gets it
too, covering the whole listing.

**Headings, anchors, scroll.** Otherwise unchanged from the viewer.

### 4.6 Data flow

**Reads.** The admin's first request is `readApi.timeline`. `PhotoPage` still
requests `readApi.photo(id)` for a direct landing, as in the viewer.

**Patching.** New module `src/shared/timeline-patch.ts` (runtime-neutral: it
must compile in all three tsconfigs, so no DOM). Pure functions over
`TimelineResponse`:

- `removePhotos(timeline, ids)`: drops the photos; drops any day, month, or
  year left empty; recomputes every count and `total`.
- `upsertPhoto(timeline, photo)`: removes the photo wherever it is, then
  inserts it under its `captureDate` (creating the day, month, or year in
  the correct newest-first position) or into undated. Within a day, a photo
  with a `captureTime` is placed in clock order among timed photos; a
  date-only photo is appended after the day's timed photos. `PublicPhoto`
  carries no batch or selection index, so exact placement among date-only
  photos is not possible client-side; the background refetch corrects it.
  Document this in the module comment.

Both are unit-tested against the counts-agree invariant the display-api
tests already assert.

**After each mutation:**

| Mutation           | Patch                                   | Then     |
| ------------------ | --------------------------------------- | -------- |
| edit               | `upsertPhoto` with the returned photo   | refetch  |
| trash confirm      | `removePhotos` with the returned IDs    | refetch  |
| restore (undo)     | none                                    | refetch  |
| upload batch done  | none                                    | refetch  |
| trash page actions | n/a (its own resource)                  | refetch trash count |

"Refetch" is `readApi.timeline` in the background; when it resolves it
replaces the patched copy. A refetch already in flight is not duplicated: the
app keeps one pending promise. The lightbox, if open, stays on its route's ID
throughout; `orderedIds` is derived from whichever timeline is current, so
neighbours update as the data does.

**Restore has no patch** because the restored photo is not in the timeline
response the client holds and the trash listing's record may be stale; a
refetch is the honest answer and the undo path is rare.

### 4.7 The admin lightbox

`Lightbox` is shared. With no curation context it renders exactly as today.
With one:

**Header.** Unchanged: the back link at top left. The original filename is
added at the top right in the same muted style, so an admin can tell which
file this is without opening Photo info.

**Bottom-left stack**, top to bottom, sharing the right edge as the viewer's
stack does:

1. An `EditForm` (new, in `src/shared/ui/`, rendered only under curation):
   Capture date (text, `YYYY-MM-DD`), Capture time (text, `HH:MM`, disabled
   while the date is blank), Caption (textarea), then a row with **Save
   changes** and the "Saved" mark or the validation error. The form's
   behaviour is the old panel's, including client-side `validatePhotoEdit`
   before the request and reflecting the stored values after a save. Its
   state is keyed on the photo ID, so arrowing resets it, and a completed
   save must not reset it (the old panel's comment on this stands).
2. The error line for a failed download or delete.
3. The action row: **Download**, **Delete**, **Photo info**.

The Photo info panel is unchanged.

**Keyboard**, in this order of precedence:

1. If `document.activeElement` is inside the form: Escape blurs it and stops;
   every other key is left to the field.
2. Otherwise: Escape closes; ArrowLeft/Right step; Delete and Backspace call
   `curation.trash(photo.id)` and `preventDefault`.

A single handler on `window`, as today, with the check for form focus at the
top. The confirm dialog already takes focus when it opens, so a second Delete
press while it is up is harmless.

**Delete.** `curation.trash(id)` runs the preview and shows the dialog. On
confirm the app: computes the next ID from the pre-patch `orderedIds` (next,
else previous, else none); patches; navigates to that ID's photo route with
`replace: true`, or closes to the timeline if there is none; raises the undo
banner; refetches. Because the navigation is a replace, Back from the new
photo does not land on the trashed one.

**Undo banner.** Rendered by the app above everything including the
lightbox, fixed at the bottom centre. It survives every navigation and
retires only on its own timer or on Undo. Undo restores and refetches.

**Height.** The stack under a landscape photo on a short window can climb
over the picture. The stack must never push the photo's box off screen or
force page scroll; if the viewport is too short, the form scrolls within the
stack. Below 40rem the stack is the footer row, as in the viewer, and the
form takes the full width there.

### 4.8 The trash page

Route `/trash`. Uses `Layout` with the same nav. Resource: `adminApi.trash`.

- Renders the items with `PhotoGrid` under a single heading "Trash", with
  the filename beneath each tile as on the timeline, plus a second line
  "Deleted <date>, purged <date>" using the existing `purgeDate` logic.
- Tiles use the signed `thumbnailUrl`, so `PhotoGrid` accepts an optional
  per-photo image source override; the default remains the capability URL.
- A plain click opens the shared `Lightbox` in read-only mode: no form, no
  Download, no Delete, Photo info available. The image source is the signed
  `previewUrl`; there is no srcset because only one rendition is signed.
  Arrows traverse the trash listing in its own order. The route does not
  change while the trash lightbox is open; it is local state, since a
  trashed photo's `/photo/<id>` is a 404 by design.
- Selection uses the same modifier gestures and the same sticky bar, whose
  actions here are **Restore** and **Delete permanently** (the latter
  through the existing preview/confirm dialog with its own copy). Deselect
  all remains.
- No download of any kind, and the full rendition is never signed.

`adminApi.trash` returns `{ items: TrashItem[]; expiresAt }` with
`TrashItem = { photo, trashedAt, thumbnailUrl, previewUrl }`.

### 4.9 The curation contract

In `src/shared/ui/curation.ts`:

```ts
export interface Curation {
  /** Photos a bulk action would cover, pruned to what is on the page. */
  selectedIds: ReadonlySet<string>;
  /** Plain click: clear the selection and make this tile the anchor. */
  anchorOn(id: string): void;
  /** Modifier-click. */
  toggle(id: string): void;
  /** Shift-click. */
  extendTo(id: string): void;
  /** A day heading's Select all: add these to the selection, keep the rest. */
  selectAll(ids: readonly string[]): void;
  /** Delete one photo: preview, confirm, then the app's post-delete flow. */
  trash(id: string): void;
  /** Save an edit; resolves with the stored photo. Rejects with a message. */
  edit(id: string, edit: PhotoEdit): Promise<PublicPhoto>;
  /** True on the trash page: the lightbox shows no form and no actions. */
  readOnly: boolean;
}

export const CurationContext = createContext<Curation | null>(null);
export function useCuration(): Curation | null;
```

`PhotoEdit` is `{ date: string | null; time: string | null; caption: string
| null }`, the shape `adminApi.edit` takes today. The context must not carry
anything the viewer could not compile against: no admin types, no admin
imports.

### 4.10 Server changes

In `netlify/functions/admin.ts`, `listTrash` signs a second grant per item
for `display-1280` and returns it as `previewUrl`. The fixture server's
`/trash` handler does the same.

In `netlify/functions/lib/read-routes.ts`, remove `/hierarchy`, `/undated`,
and `DAY_ROUTE`. The module comment is rewritten: both functions still share
it, now for `/timeline` and `/photo`. In `src/shared/display-api.ts`, remove
`hierarchyResponse`, `dayResponse`, `undatedResponse`, `HierarchyResponse`,
`GroupResponse`, `YearCount`, `MonthCount`, `DayCount`, and any helper only
they used; keep `GroupRef` and `PhotoResponse`. In `config/fixture-server.ts`
remove the three handlers. Update or delete the affected cases in
`tests/unit/read-routes.test.ts` and `tests/unit/display-api.test.ts`.

The Worker is untouched. No new environment variable.

### 4.11 Styles

`display.css` is the base for both apps. `admin.css` keeps upload, queue,
confirm, and undo, and gains: the filename line under a tile, the selected
tile wash, the sticky bar, the edit form inside the lightbox stack, and the
trash page's second caption line. Everything else in it is deleted. Both
apps keep their present `main.tsx` import order.

## 5. Test coverage required

Names are the implementer's. Every behaviour below needs an e2e test unless
noted as unit. The existing admin e2e suite is rewritten; tests for the
detail panel, the enlarged photo, and level-by-level browsing are deleted,
not ported. The Select all test is rewritten against the day heading.

Stage 1:

- The whole display and mobile suites pass unchanged.
- No admin path or admin code in the display build (existing test).

Stage 2, timeline:

- The admin shows the same timeline as the viewer, with the upload target
  above it, Trash (n) and Export in the header, and a filename under every
  tile.
- Deep URLs scroll the admin timeline as they do the viewer's.
- Modifier-click selects without navigating; shift-click extends across a
  day boundary; a plain click clears the selection and opens the lightbox;
  the sticky bar appears with the count and disappears at zero.
- A day heading's Select all selects that day and only that day, adds to
  an existing selection elsewhere rather than replacing it, and disappears
  once the whole day is selected, returning when one photo is deselected.
- Delete selected states the resolved count, removes the photos from the
  page without a reload, and offers Undo, which puts them back.

Stage 2, lightbox:

- Opens on a plain click; arrows traverse the library; the form shows the
  photo's values and resets on arrow.
- Saving a caption and a corrected date moves the photo to the new day on
  the page without a reload, and the change persists across a reload.
- An impossible date is rejected without a request.
- Arrow keys and Backspace inside the caption field move the caret and
  delete characters; they do not navigate or trash. Escape in a field blurs
  it; a second Escape closes.
- Delete (button and key) shows the confirmation; confirming trashes and
  advances to the next photo; on the last photo it steps back; on the only
  photo it closes. Cancelling changes nothing.
- The undo banner outlives an arrow press and a close, and is gone after
  five seconds (use a clock override or accept the wait).
- The filename is visible in the lightbox.

Stage 2, trash:

- Trashed photos appear as tiles with signed thumbnails; opening one shows
  the signed preview and offers no download; restore and permanent delete
  work through the bar with confirmation for the latter.
- The display site never requests a trashed derivative (existing test).

Unit:

- `timeline-patch`: removal recomputes counts and drops empty groups;
  upsert moves a photo between days, creates and removes groups, places a
  timed photo in clock order, and keeps counts agreeing with the photos
  present.
- `routes` with and without `extra`: `/trash` parses only for the admin.
- `read-routes`: the removed paths return `null`.
- `selection.test.ts` unchanged.

## 6. Documentation updates

### 6.1 `docs/design.md`, "Admin site" section, replacement text

Replace everything from `## Admin site` up to `### Trash` with:

> ## Admin site
>
> The admin site is the display site with curation added. It is the same
> one-page timeline and the same photo view, reached through its own opaque
> path, and everything below applies on top of the display site's rules.
>
> - The header gains a persistent **Trash** link with an item count and an
>   **Export catalog** link. Every thumbnail shows its original filename.
>   The upload drop area sits above the timeline, prominent when the library
>   is empty and large and easy to target thereafter; the in-progress queue
>   shows per-file states (processing, uploading, done, skipped as duplicate,
>   failed with reason and retry). There is no persistent server-side
>   "processing" area; a file either commits fully or leaves no record.
> - Clicking a thumbnail opens the photo view, which for an admin carries the
>   edit form in place of the caption and date text: capture date, capture
>   time, caption, and **Save changes**, with **Download**, **Delete**, and
>   **Photo info** beneath. The original filename shows at the top right.
>   Nothing is saved until Save; arrowing away or closing discards an
>   unsaved edit. While a field has focus the keyboard belongs to it: arrows
>   move the caret, Escape leaves the field, and only a second Escape closes
>   the view. With focus outside the form, Delete or Backspace is the same
>   as the Delete button.
> - Delete, single or bulk, always confirms through the preview-and-confirm
>   dialog, which states the resolved count and applies to exactly the
>   photos it named. After a single delete the photo view advances to the
>   next photo (or the previous at the end, or closes if none remain). A
>   brief Undo appears and lasts five seconds regardless of what the admin
>   does in the meantime.
> - Selection is by modifier-click (Command, or Control away from a Mac) and
>   shift-click, which extends from the last photo modifier-clicked across
>   any day, month, or year boundary. A plain click opens the photo view and
>   clears the selection. There is no marquee dragging. Each day heading
>   carries a **Select all** for that day, shown only while one of its photos
>   is unselected; it adds to the selection rather than replacing it, and
>   there is no library-wide Select all. While anything is selected a bar
>   pinned to the top of the page shows the count, **Delete selected**, and
>   **Deselect all**; it is absent otherwise. No selection control is ever
>   shown disabled. Bulk delete is the only bulk action; date, time, and
>   caption are per-photo.
> - After an edit or a delete the page updates in place from the server's
>   reply and quietly refetches the library afterwards, so the page never
>   waits on a reload and never stays out of step for long.
> - Mobile viewing is responsive. Admin workflows are explicitly
>   laptop-oriented; touch-specific bulk-selection UI is out of scope.

In `### Trash`, change the last sentence of the fourth bullet to: "Trashed
photos cannot be downloaded, but the Trash shows them on the same grid and
photo view as the library, with thumbnails, filenames, original date, and
deletion date for safe identification; both images are short-lived signed
URLs."

### 6.2 `docs/implementation-plan.md`

- "Repository structure": `shared/` line becomes "catalog types,
  date/validation logic, and under `ui/` the whole viewer UI both apps
  render". Add a sentence after the two-builds paragraph: "The viewer UI
  lives in `src/shared/ui/` and is imported by both builds; nothing under
  `src/shared/` imports from either app, and the admin is that UI with a
  curation context provided."
- "Display API": delete the hierarchy/group bullet. Note that `/timeline`
  and `/photo` are the only projections.
- "Admin API": trash listing "returns signed thumbnail and preview URLs".
- "UI implementation order": replace steps 3 to 5 with the stage-2 order:
  shared curation context and admin lightbox form, selection and sticky
  bar, upload above the timeline, trash page on the shared grid, endpoint
  removal.

### 6.3 `docs/decisions.md`

Add a dated section "The admin becomes the viewer" recording decisions 1
through 23 above in the file's style, with the rejected alternatives. Note
explicitly that #26 (keeping `/hierarchy`, `/day`, `/undated` for the admin)
is superseded, that #35 is amended (plain click now opens the lightbox, and
"a second marked photo closes the panel" no longer applies), that #36 is
amended (Select all moves from the toolbar to each day heading, and the
toolbar becomes a sticky bar shown only while something is selected), and
that #37 is superseded (the lightbox is the enlarged view).

### 6.4 `CLAUDE.md`

- Architecture table: viewer entry is `src/display/` plus `src/shared/ui/`;
  admin entry is `src/admin/` plus `src/pipeline/` plus `src/shared/ui/`.
- "The two apps are separate builds": add "Nothing under `src/shared/` may
  import from either app. The admin augments the shared UI through
  `CurationContext`; the viewer provides `null`."
- Invariants: add "`src/shared/ui/` is the only place under `src/shared/`
  where DOM globals are allowed; `src/shared/timeline-patch.ts` is not in
  it and must stay runtime-neutral."
- Remove the sentence in "Local development fake" about the four missing
  read routes only if the fixture's fall-through is also removed; otherwise
  leave it, since the lesson still applies.

### 6.5 Code comments that go stale

`src/admin/api.ts` header ("extends the display hierarchy"), the
`read-routes.ts` header, the `/timeline` comment in `ui/api.ts` about routes
kept for the admin, and `display-api.ts`'s `HierarchyResponse` comments.
Search for "hierarchy" and "detail panel" across `src/`, `netlify/`, and
`config/` after stage 2 and fix each hit.

## 7. Out of scope

Search, tags, albums, manual reordering, bulk metadata edits, touch
selection, a jump-to-date side nav (decisions.md #34), any Worker change,
any gate change, and any change to what the display site renders.

## 8. Implementer's discretion

- Subdirectory layout inside `src/shared/ui/`.
- How the sticky bar's height is communicated to the pinned headings.
- Whether the edit form's Save is also triggered by Cmd/Ctrl+Enter in the
  caption textarea (plain Enter must insert a newline there).
- Exact copy of the trash page's confirmation dialog.
- Whether stage 2 lands as one commit or several; stage 1 is its own commit
  and ships first.
