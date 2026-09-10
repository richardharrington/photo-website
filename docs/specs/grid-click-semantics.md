# Click selects, double-click opens

Spec, 2026-09-09. Written after a design interview; the decisions below are
settled unless marked "implementer's discretion". A separate agent implements
this. Where this spec and the code disagree, the spec wins; where it and
`docs/design.md` disagree, the spec wins and the doc is updated (section 14).

## 1. Outcome

In the admin's selecting listings — the library timeline, Recently added, and
the trash — a plain click on a tile **selects** the photograph and never opens
it. A **double-click** opens the photo view without the open itself disturbing
the selection. Modifier-click and shift-click are untouched.

The viewer does not change in any way. Neither does the upload panel, whose
tiles have nothing to select and keep opening on a single click.

Reason: the current rule is the odd one out. Every file manager and photo
manager on both platforms teaches click-to-select and double-click-to-open,
and this app instead makes a plain click the *destructive* gesture — it clears
the selection — while selection itself is reachable only through a modifier
most people never try. Decision #35 recorded the current arrangement and #48
amended it; this supersedes both on the click rule and leaves the rest of #35
standing.

## 2. The gestures

| Gesture                | Selecting listing (library, Recently added, trash)                       | Non-selecting (viewer, upload panel) |
| ---------------------- | ------------------------------------------------------------------------ | ------------------------------------ |
| Plain click            | Select this photo alone. **If already selected, the selection is left exactly as it is.** The anchor moves to this tile either way. Never opens. | Opens the photo view (unchanged)     |
| Double-click           | Opens the photo view                                                      | Opens (harmless; see 12.4)           |
| ⌘/Ctrl-click           | Toggle this photo (unchanged)                                             | Nothing (unchanged)                  |
| Shift-click            | Extend from the anchor, additively (unchanged)                            | Nothing (unchanged)                  |
| Enter (keyboard)       | Opens the photo view                                                      | Opens (unchanged)                    |
| Space (keyboard)       | Plain-click semantics                                                     | Nothing                              |
| Long-press (touch)     | Opens the photo view                                                      | n/a — a tap opens                    |
| Middle-click, right-click → Open in New Tab | Native browser behaviour, still works on the library's anchor tiles | Unchanged            |

## 3. Decisions

Numbered so the implementation and the docs can cite them.

1. **No timer. The selection applies on the first click, always.** A
   double-click fires `click`, `click`, `dblclick`. The second `click` lands
   on a photo the first one just selected, so decision 2's idempotency makes
   it a no-op. Nothing has to wait to find out whether a second click is
   coming, and no selection state has to be snapshotted and restored.

   Rejected: delaying the selection until the double-click window closes.
   The threshold is ~300ms at minimum and macOS lets a user set it near a
   second; the established bar for an interaction reading as instantaneous is
   100ms. It would put perceptible lag on the commonest gesture on the page in
   order to protect a case that does not need protecting.

   Rejected: applying the selection and undoing it on `dblclick`. It buys the
   same guarantee at the cost of a visible flash of a selection about to be
   taken back.

   The consequence, accepted knowingly: double-clicking a photo that is **not**
   already selected also collapses the selection onto it before opening. That
   is what Finder, Explorer, Photos and Lightroom all do, so it will not read
   as a violation. The case that matters — double-clicking *into* a
   multi-selection you built deliberately — is fully protected by decision 2.

2. **A plain click is idempotent on an already-selected photo.** This is not a
   nicety; it is the mechanism decision 1 rests on. Do not "simplify" it into
   a toggle. A toggle would deselect the photo on the second click of every
   double-click.

3. **The anchor moves on every plain click, including the idempotent one.**
   The selection may be untouched, but the click still says "you are here",
   and that is what a following shift-click measures from. This is the rule
   #35 had to add for exactly this reason: without it, the commonest gesture
   of all — click one, shift-click another — found no anchor and marked a
   single tile.

   So: A–F selected with the anchor on A, plain-click D, shift-click F gives
   **D–F**.

4. **Which listings select is a fourth capability, `Capabilities.select`.**
   `src/shared/ui/curation.ts:63` already carries `edit`, `download` and
   `trash`, and its own comment explains why three flags rather than one
   `readOnly`: the listings do not differ along a single axis. This is more of
   the same. Required, not optional, so the compiler visits all three call
   sites and no listing inherits a default.

   | Site                     | `select` | Why                                        |
   | ------------------------ | -------- | ------------------------------------------ |
   | `src/admin/App.tsx:257`  | `true`   | Library timeline and Recently added        |
   | `src/admin/components/TrashPage.tsx:154` | `true` | Restore and Delete permanently act on a selection |
   | `src/admin/components/Upload.tsx:241`    | `false` | Every selection method there is a stub     |
   | Viewer                   | —        | No curation context at all                 |

   Rejected: a prop on `PhotoGrid`, which would give two mechanisms for saying
   what a listing can do. Rejected: inferring it from a stubbed curation, which
   makes a stub indistinguishable from a listing that merely has nothing
   selected at the moment.

5. **The upload panel and the library disagree on the same screen, and that is
   accepted.** A pending tile opens on one click; a library tile below it
   selects. They sit under their own headings, every pending tile carries a
   progress bar and a state label, and the alternative is a selection that can
   do nothing — which decision #36 exists to prevent.

6. **Enter opens, Space selects.** The library's tiles stay real anchors with
   real `href`s, so Enter keeps doing what it has always done and the photo's
   URL stays copyable and middle-clickable. Space becomes the keyboard's plain
   click. See 12.1 for the trap this hides.

   Rejected: making tiles `<button>`s, which would discard the shareable URL.
   Rejected: Enter-selects-then-Enter-opens, which would stop Enter from
   following a link.

7. **On touch, a tap selects and a long-press opens.** Today an iPad can open
   photos and cannot select at all; this gives touch both actions. Double-tap
   is not available — it fights the browser's zoom gesture.

   Threshold: 500ms (implementer's discretion, ±100ms). The press must cancel
   on `pointermove` past a small slop radius, on `pointerup`, and on
   `pointercancel`, because the grid is a long scrolling list and a press that
   becomes a scroll must not open anything. See 12.5.

8. **The detail view never touches the selection.** Open, arrow to another
   photo, close: the selection and the anchor are exactly what they were. This
   is the promise that makes rule 2 worth having — double-click into a
   selection of five, inspect one, close, and you still have five.

   The consequence, accepted knowingly: `close()` at
   `src/shared/ui/PhotoPage.tsx:106` scrolls to the photo *currently shown*, so
   after arrowing from C to F you land scrolled to F with C still highlighted.
   The highlight answers "what would a bulk action hit", which is a different
   question from "what am I looking at".

9. **Escape clears the selection, and so does a click on the page background.**
   Escape only when the detail view is closed and focus is outside a field —
   #43's handler already stands down in both cases. The background click means
   the page margins either side of the grid, not empty space inside the masonry
   columns, which #35 notes is not dependable.

10. **The selection bar's behaviour is unchanged, and it will now be up almost
    all the time.** The pinned year and month headings will shift down by
    `--selection-bar-height` on the first click and back on Deselect all.
    Accepted: the bar appearing is the confirmation that the click registered,
    and the tile wash alone is easy to miss.

11. **The selected-tile treatment is unchanged** (`admin.css:257`). Noted and
    rejected during the interview: lightening it for a single selection. It is
    a CSS change, revisitable at any time without touching anything here.

12. **The gesture is taught in prose, and in a `title` on each tile.** The
    trash already carries an intro line; the library and Recently added get one
    too. The tooltip does nothing for touch, so the prose must name the
    long-press as well as the double-click.

    Wording is implementer's discretion; it must state both gestures in the
    listing's own voice, and must not appear in the viewer.

## 4. The selection algebra

`src/admin/selection.ts` gains one pure function and loses `anchorOn`.

```ts
/**
 * A plain click: the selection becomes this photograph alone — unless it is
 * already selected, in which case the selection is left exactly as it is.
 *
 * That idempotency is load-bearing, not tidiness. A double-click fires click,
 * click, dblclick; the second click lands on a photo the first one selected,
 * so it does nothing, and opening on a double-click therefore needs no timer
 * and no snapshot of the selection to restore.
 *
 * The anchor moves either way. The click still says "you are here", which is
 * what a following shift-click measures from (decisions.md #35).
 */
export function selectOnly(state: SelectionState, id: string): SelectionState {
  if (state.ids.has(id)) return { ids: state.ids, anchorId: id };
  return { ids: new Set([id]), anchorId: id };
}
```

`anchorOn(id)` — which returned an *empty* selection anchored on `id` — is
removed, along with its uses in `App.tsx` and `TrashPage.tsx`. The `Curation`
interface's `anchorOn` becomes `selectOnly(id: string): void`, and its doc
comment is rewritten from "Plain click: clear the selection and make this tile
the anchor."

`toggle`, `extendTo`, `selectAll`, `addAll`, `allSelected`, `pruneToVisible`
and `selectedIds` are untouched.

Put the branch in the pure function, not in `PhotoGrid`. The grid can read
`curation.selectedIds`, but the decision belongs in the reducer where it is
unit-testable in one place.

## 5. `PhotoGrid`

`onTileClick` (`src/shared/ui/PhotoGrid.tsx:60`) becomes, for a curation with
`can.select`:

- `shiftKey` → `preventDefault`, `extendTo` (unchanged)
- `metaKey || ctrlKey` → `preventDefault`, `toggle` (unchanged)
- otherwise → `preventDefault`, `selectOnly`. **New:** the default is now
  prevented in this branch too, which is what stops the anchor from navigating.

With no curation, or with `can.select === false`, the handler is what it is
today: the plain click is left alone and the link or the `open` callback opens
the photo.

A new `onDoubleClick`, active only when `can.select`:

- On the anchor path, `navigate(photoHref(photo.id))` —
  `src/shared/ui/navigation.ts` exports it and it already no-ops when the path
  is unchanged.
- On the `open` path (trash, upload panel), `open(photo)`.

Both tile elements gain `user-select: none` (12.3) and a `title` (decision 12).

## 6. Keyboard

Handle Enter and Space in `onKeyDown` on the tile, and ignore keyboard-
synthesised clicks in `onClick` (12.1):

- `Enter` → open, exactly as a double-click does.
- `' '` → `preventDefault` (or the page scrolls), then `selectOnly`.

Only when `can.select`. Without it, leave the native behaviour alone.

## 7. Touch

Long-press, only for `event.pointerType === 'touch'` and only when
`can.select`. Sketch, not prescription:

- `pointerdown` → record the point, start the timer.
- `pointermove` beyond the slop radius, `pointerup`, `pointercancel`, or a
  scroll → clear the timer.
- Timer fires → open, and suppress the `click` that will follow.

The tile needs `-webkit-touch-callout: none` and a `contextmenu` handler that
calls `preventDefault`, or iOS shows its own link/image sheet over the gesture.
Do **not** set a `touch-action` that stops panning; the grid must still scroll.

## 8. What does not change

- The viewer, in every respect. It has no curation, so every branch here is
  behind a `null` check it already performs.
- Modifier-click and shift-click, and the additive shift-range of #35.
- The upload panel's tiles: single click opens, as today.
- The selection bar's contents, its `--selection-bar-height` publishing, and
  the "never a disabled control" rule of #36.
- The selected-tile CSS.
- The Delete key, which lives only in the photo view (`Lightbox.tsx:263`) and
  acts on the open photograph. There is no grid-level Delete, so making a
  selection easier to arm creates no keyboard hazard. **Do not add one.**
- Every bulk action, confirmation dialog, and audit path.

## 9. A consequence worth naming

A day heading's **Select all** followed by one stray plain click collapses the
whole day to one photo, with no undo. #35 calls that a feature — "a range that
caught too much is always one plain click from being started over" — and it
stays true. But today that click also opens a photo, so it is a deliberate act;
after this it is the lightest gesture on the page. Escape and the background
click (decision 9) do not help, since they clear rather than restore.

Accepted as specified. Do not add a confirmation, and do not add an undo.

## 10. Traps in the code

1. **A keyboard-activated click is still a `click` event.** Enter on an
   `<a>`, and both Enter and Space on a `<button>`, fire `click` with
   `event.detail === 0`; mouse clicks have `detail >= 1`. Without that test,
   Enter on a trash tile would select instead of opening. Handle the keys in
   `onKeyDown` and have `onClick` return early on `detail === 0`.

2. **`Link` runs the caller's `onClick` first and honours its
   `preventDefault`** (`src/shared/ui/Link.tsx:20`). That is the existing
   mechanism and it is why a plain click can stop navigating without a second
   element to click on. Nothing new is needed; do not reach for `<a
   onClick={e => e.preventDefault()}>` wrappers.

3. **Double-clicking selects text.** Add `user-select: none` to the tile, or
   the filename caption under each thumbnail highlights on every open.

4. **Use the native `dblclick` event.** It respects the user's system
   double-click speed. A hand-rolled timer would not, and there is no reason
   for one — see decision 1.

5. **A long-press that becomes a scroll must not open.** The grid is one
   scrolling page years long; this is the failure that makes long-press feel
   broken, and `pointercancel` alone does not always arrive.

6. **`Capabilities` is required, not partial.** Adding `select` will break all
   three `can: { … }` literals at compile time. That is the point; fill in all
   three rather than defaulting.

7. **The fixture server and the two Functions are not involved.** This is a
   browser-side change only. No API, no catalog, no storage seam.

## 11. Tests

**Unit** — `tests/unit/selection.test.ts`:

- `selectOnly` on an unselected photo replaces the selection and sets the
  anchor.
- `selectOnly` on an already-selected photo returns the same ids and moves the
  anchor. Assert the ids explicitly; this is decision 2 and it is what makes
  the whole design work.
- Applying `selectOnly` twice to the same id is identical to applying it once
  — the double-click sequence, asserted directly.
- A–F selected, anchor A, `selectOnly(D)` then `extendTo(F)` gives D–F
  (decision 3).

**Component** — under `@vitest-environment happy-dom`, on `PhotoGrid`:

- With `can.select`, a plain click marks the tile and calls neither `navigate`
  nor `open`.
- With `can.select`, a double-click opens and the selection is unchanged.
- With `can.select === false`, a plain click opens and marks nothing.
- Enter opens; Space marks; a click with `detail === 0` does neither twice.

**E2E** — `tests/e2e/admin.spec.ts` only. `display.spec.ts`, `recent.spec.ts`
and `mobile.spec.ts` are the viewer at `/dev-display-path` and must keep
passing untouched, which is the regression test that the viewer did not
change.

These plain `.click()`s expect the photo view and become `.dblclick()`:

| Line | Listing                                       |
| ---- | --------------------------------------------- |
| 159  | Library — drop target stands down              |
| 667  | Library — a photo that has landed              |
| 712  | Trash — opens its dialog, URL stays `/trash`   |
| 766  | Library — delete from the photo view           |
| 814  | Recently added — "a plain click opens…"; the comment needs rewriting too |

**Line 636 stays a single `.click()`.** It is a still-uploading tile in the
upload panel, where `select` is `false`. If it needs a `.dblclick()` to pass,
decision 4 has been implemented wrongly.

Add: a plain click marks a library tile and opens nothing; a double-click into
a three-photo selection opens the photo and leaves the bar reading `3
selected`; Escape clears; arrowing in the photo view and closing leaves the
selection as it was.

## 12. Documentation

- `docs/design.md:397` — the selection paragraph states the old rule outright
  ("A plain click opens the photo view and clears the selection"). Rewrite it
  for the new gestures, including Enter, Space, and the long-press.
- `docs/decisions.md` — one new numbered entry. It supersedes the click rule
  in #35 and #48 and must say so, the way #48 says it amends #35. It should
  record: why the convention won; that no timer is needed and why (the
  idempotency); that `select` became a fourth capability; that the upload
  panel keeps the old rule on the same screen; and the Select-all consequence
  in section 9.
- `CLAUDE.md` — no change. Nothing here touches an invariant it records.

## 13. Deliberately not decided

- The long-press threshold beyond "about 500ms", and the slop radius.
- The exact wording of the help lines and the tile `title`.
- Whether Space should scroll the tile into view when it selects.
- Whether the selected-tile treatment should lighten for a single selection.
  Raised, and left as it is (decision 11); revisit after living with it.
