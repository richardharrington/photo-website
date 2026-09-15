# The photo view opens to read

Spec, 2026-09-15. Written after a design interview; the decisions below are
settled unless marked "implementer's discretion". A separate agent implements
this, without the interview's context. Where this spec and the code disagree,
the spec wins. Where it and `docs/design.md`, `docs/decisions.md`, or
`docs/specs/family-tier.md` disagree, this spec wins and section 9 amends
them.

## 1. Outcome

Opening a photograph shows it with as little around it as possible: its date,
its caption, and a row of buttons. Nothing is a field. One of the buttons is
**Edit**, and it brings up the editing view that exists today — the date,
time, and caption fields with Save — minus Download.

This holds at every screen width, in both apps, for every listing that can
edit (both libraries, both Recently added views, and the files still
uploading in both apps). The trash cannot edit and is unchanged except for the
date line (decision 3).

Reason: on a phone the edit form sits between the picture and the buttons and
takes its height straight out of the picture's, so photographs are too small.
More broadly, the owner misses the plain view the site had before the family
could edit (family-tier.md): the view people see most of the time should be
mostly read-only, because it is cleaner to look at. Editing becomes a
deliberate step.

This reverses decisions.md #41, which put the form in the photo view "always"
with "no Edit toggle: editing is what an administrator is there for, and a
toggle puts a click in front of every correction." The owner accepts that
click, for the administrator too.

## 2. Where things stand today

Line numbers are approximate; search for the quoted text.

- **One photo view for everything.** `src/shared/ui/Lightbox.tsx` is rendered
  by `PhotoPage.tsx` (library and Recently added, one route per photo),
  `TrashPage.tsx` (local state, no route), and `Upload.tsx` (files still
  uploading, local state, no route). Both apps use it.
- **What it may do comes from the curation context,** `src/shared/ui/curation.ts`.
  `Capabilities` has eight flags; the table in its doc comment (~line 63)
  lists them per listing. This spec uses `edit`, `download`, `trash` (via
  `canTrash`), `restore`, `purge`, and `filename`. It adds no flag.
- **`editable`** (`Lightbox.tsx` ~line 107, `curation?.can.edit ?? false`)
  decides two things today: the root class `lightbox lightbox--editing`
  (~line 418), and whether the bottom stack renders `<EditForm>` or the
  read-only `.lightbox__meta` block (~lines 541–559).
- **The read-only block exists already** and is what the trash shows: caption
  paragraph (`.lightbox__caption`) then date paragraph (`.lightbox__date`,
  `formatCaptureDate`, no time), each omitted when absent, and the whole
  block omitted when both are.
- **The action row** (`.lightbox__actions`, ~line 567): Download
  (`can.download`), Delete (`canTrash`), Restore (`can.restore`), Delete
  permanently (`can.purge`), Photo info (always).
- **Per-photo state is keyed by photo ID,** not held as a boolean:
  `infoFor` (~line 124) is the ID the Photo info panel is open for, so
  stepping to another photo closes the panel "as a matter of arithmetic".
  This spec uses the same pattern three more times.
- **Stepping** is `step(delta)` (~line 180). It already refuses while
  `dirty`, and the two `.lightbox__nav` buttons are disabled while `dirty`
  with the title "Save or discard your changes first".
- **The keyboard** is one `keydown` listener on `window` (~lines 248–310):
  focus anywhere inside the form → Escape blurs, everything else is left to
  the field; focus in some other layer (the confirm dialog) → ignored; else
  Escape closes the info panel if open, otherwise calls `onClose`;
  ArrowLeft/ArrowRight step; Delete/Backspace trash where `canTrash`.
- **`src/shared/ui/EditForm.tsx`** holds the fields (labels "Capture date"
  ~line 134, "Capture time" ~line 145, "Caption"), its own `saved` flag and
  "Saved" / "Unsaved changes" / error messages beside **Save changes**
  (~line 175), and reports `dirty` through `onDirtyChange`. It unmounts
  reporting `false`. Its header comment (~line 23) argues against an Edit
  toggle. Nothing but `Lightbox.tsx` renders it.
- **Layout.** `src/shared/styles/display.css` ~line 496 onward. Below 40rem
  the view is one column: back link, stage (`flex: 1`), foot (`flex: none`).
  At 40rem and above, the chrome is in the corners and the bottom stack hangs
  20px off the picture's measured left edge, `--photo-left`; the stack is a
  right-aligned column, caption above date, buttons stacked vertically with
  Photo info lowest. `src/shared/styles/curation.css` ~line 405 adds
  `.lightbox--editing`: the stage starts at `left: 21rem`, the foot takes a
  fixed 20rem gutter, and the action row goes horizontal.

## 3. Vocabulary

- **Photo view** — the `Lightbox` component, whatever it is showing.
- **Editing listing** — a listing whose context has `can.edit`. Today: both
  libraries and Recently added views, and both apps' files still uploading.
- **Read view** — what an editing listing's photo view shows on opening: date
  line, caption, action row. No fields.
- **Edit view** — the form, reached by Edit.
- **Unsaved** — the form's existing `dirty`: a field differs from the stored
  record.
- **Narrow / wide** — below / at or above the existing 40rem breakpoint.
  Nothing in this spec *behaves* differently by width; only layout,
  caption order, and the clamp's line count do.

## 4. Decisions

1. **Every editing listing opens in the read view, at every width, in both
   apps.** Supersedes decisions.md #41's "always" and "No Edit toggle".

   Rejected: narrow screens only. An iPhone in landscape is wider than 40rem
   (844px for an iPhone 12, 667px for an SE), so a phone would switch
   behaviours on rotation, and the owner wants the clean view on laptops too.
   Rejected: by device (`isPhoneBrowser()`). Rejected: family only, which
   would have needed a ninth capability.

2. **The read view's action row is Download, Edit, Delete, Photo info**, each
   as today's capabilities allow, in that order. Edit appears only in an
   editing listing. So:

   | Listing                          | Read view row                             |
   | -------------------------------- | ----------------------------------------- |
   | Family library / Recently added  | Download, Edit, Delete (added here only), Photo info |
   | Admin library / Recently added   | Download, Edit, Delete, Photo info        |
   | Either app's files uploading     | Edit, Photo info                          |
   | Either trash                     | Unchanged: Restore, Delete permanently where `can.purge`, Photo info |

   Photo info stays in the read view because "Added from" exists to explain a
   missing Delete (family-own-trash.md #4), and that question is asked in the
   read view.

3. **The date line is the date alone, and "Undated" when there is none.**
   `formatCaptureDate(photo.captureDate)`, never the time; the time stays in
   Photo info. No "Capture date" label. "Undated" matches the timeline's
   section heading and the trash tiles. This applies to the read-only block
   wherever it renders, so the trash's photo view gains "Undated" too —
   intended, since it is the same block.

4. **No caption, no caption line.** No placeholder.

5. **Order: date then caption when narrow; caption then date when wide**, as
   the wide corner stack is today. Render the date first in the DOM and move
   the caption above it in the wide rule with `order`, so screen-reader order
   is one thing.

6. **A long caption is clamped, with More.** Clamped to 4 lines narrow, 10
   lines wide (the wide column is only 9.5rem). A **More** button appears
   only when the caption is actually clamped; it expands the caption in place
   and becomes **Less**. Expansion is per photograph: keyed by photo ID like
   `infoFor`, so stepping to another photo starts collapsed. An expanded
   caption is capped at half the viewport height and scrolls inside its own
   box, so the picture keeps at least half the screen and the buttons stay
   visible. The owner chose the cap for phones; apply it at every width too,
   so a long caption cannot climb off the top of a short laptop window.

   Rejected: showing it all (a long caption shrinks the picture, the original
   problem); a fixed-height scrolling box with no More; an overlay sheet.

7. **The edit view is today's editing view, minus Download.** The form, then
   an action row of Delete (where `canTrash`) and Photo info. The filename
   corner stays where `can.filename`. The form's labels become **Date**,
   **Time**, and **Caption**. Photo info keeps its own "Capture date" label,
   beside "Camera UTC offset", where "capture" says more.

8. **The form's buttons are Save changes and Cancel.** Cancel sits beside
   Save, in `.edit-form__actions`, and is `type="button"`.

9. **Save changes is disabled until something is unsaved** (and, as today,
   while saving). ⌘/Ctrl+Enter in the caption does nothing while Save is
   disabled. Cancel is always enabled.

10. **A successful save returns to the read view** and shows **Saved** there,
    under the action row, for a few seconds. Keyed by photo ID, so stepping
    clears it; closing clears it. Duration about three seconds, and whether
    it fades: implementer's discretion. The "Saved" message inside the form
    goes, because the form is gone when a save succeeds.

11. **A failed save stays in the edit view** with the error beside Save and
    everything typed still in the fields, exactly as today.

12. **Cancel discards silently** and returns to the read view. No
    confirmation.

13. **Edit adds no history entry.** Swiping back, the browser's Back, and
    "← Lightbox" close the photo from either view, as they do today, and
    discard anything unsaved. None of them can be refused.

    Rejected: a history entry so Back leaves the edit view. The router
    (`navigation.ts`) keys on the pathname alone, so it would need an
    invisible state entry and extra rules for "← Lightbox" pushing the
    timeline on top of it (Back would then reopen the photo already in edit
    mode), and a swipe back still could not be refused with unsaved typing.

14. **The arrows are hidden in the edit view,** not disabled — absent. The
    ArrowLeft/ArrowRight keys do nothing there either. To move on, Save or
    Cancel, then step.

    Rejected: staying in the edit view while arrowing, for captioning a run of
    photographs. The owner chose it and then reverted it; the extra click per
    photograph is accepted. The existing `dirty` guard on `step` becomes
    unreachable from the buttons; keep `step` refusing while editing, which
    covers it.

15. **Escape in the edit view unwinds one layer at a time,** and never
    silently discards typing while leaving you on the photograph:

    1. Focus anywhere inside the form (a field, Save, Cancel): Escape blurs.
       Unchanged.
    2. Otherwise, the Photo info panel is open: Escape closes it. Unchanged.
    3. Otherwise, **unsaved: Escape does nothing.** "Unsaved changes" beside
       Save is the explanation.
    4. Otherwise: back to the read view.

    From the read view, Escape closes the info panel, then the photograph, as
    today.

    The reasoning is the code's own, at `Lightbox.tsx` ~line 172: "a caption
    typed into a photograph and then silently dropped is worse than an arrow
    key that does nothing." Closing the photograph is different — it reads as
    leaving — and stays as it is (decision 13).

16. **Opening Edit focuses no field.** On a phone, focusing a field raises the
    keyboard over half the screen before the person has seen the form. Move
    focus to the dialog element instead, so a keyboard user is not left on
    an unmounted button. On returning to the read view (Save, Cancel,
    Escape), focus the Edit button. Implementer's discretion on the exact
    targets, as long as no field is focused and focus never lands on `body`.

17. **Every arrival is in the read view.** The edit view belongs to one
    photograph: hold it as `editingFor: string | null`, keyed by photo ID
    like `infoFor`. So stepping (not possible from the edit view, but
    possible after Save or Cancel), advancing after a delete, and reopening a
    photograph all land in the read view with no reset effect.

18. **Delete still works from the edit view** — the button, and
    Delete/Backspace with focus outside the form. The confirm dialog is the
    deliberate step, so an unsaved edit does not block it. Confirmed: the view
    advances as today and the next photograph opens in the read view
    (decision 17). Cancelled: the edit view is still there with the typing
    intact (the lightbox stays mounted under the dialog).

19. **The Photo info panel is independent of the mode.** Entering or leaving
    the edit view does not open or close it; stepping still closes it.

20. **Wide layout: the read view uses the non-editing corner layout, the edit
    view uses today's editing gutter, and the switch is animated.** The
    `lightbox--editing` class is applied only while in the edit view. The
    read view's stack hangs off `--photo-left` like the trash's does today,
    with four buttons in its vertical column, Photo info still lowest. The
    picture slides right when Edit opens (the stage's `left` goes from the
    page margin to 21rem) and back on return: transition it, about 200ms
    (implementer's discretion), and not at all under
    `prefers-reduced-motion: reduce`.

    Rejected: an instant jump (the owner prefers the slide); floating the form
    over the picture so it never moves.

21. **Narrow layout: nothing new.** The read view is today's column with the
    read-only block and a one-row action row. The edit view is today's
    column: the form above a row of Delete and Photo info. The picture shrinks
    while editing; that is accepted, since editing is now brief and
    deliberate.

## 5. Scenarios

**A family member on an iPhone taps a photo in the library.** The photo fills
most of the screen. Under it: "August 2, 2026", the caption clamped to four
lines with More if it runs longer, and one row: Download, Edit, Delete (only
if this phone added it), Photo info. Next/previous arrows are either side of
the picture. They tap Edit: the picture shrinks, and the form appears with
Date, Time, Caption, **Save changes** (disabled), **Cancel**, and below it
Delete and Photo info; the arrows are gone; no keyboard pops up. They tap the
caption, type, tap Save. The read view returns with the new caption and
"Saved" under the buttons for a few seconds. They tap next: the next photo,
read view, no "Saved".

**The same person taps Edit, types, then swipes back.** The photo closes and
the typing is lost, as today.

**An undated photo with no caption.** The read view shows "Undated" and the
row; nothing else.

**The administrator on a laptop double-clicks a tile.** The corner layout: the
filename at the top right, and at the bottom left, right-aligned beside the
picture, caption then date, then Download, Edit, Delete, Photo info stacked.
Click Edit: the picture slides right, the form fills the 21rem gutter with
Delete and Photo info across one row beneath it, and the arrows disappear.
They type a caption, press Escape (the field blurs), press Escape again:
nothing happens, "Unsaved changes" is showing. They click Cancel: the picture
slides back, the old caption shows. Escape now closes the photo.

**A file still uploading.** Its read view offers Edit and Photo info. Edit
behaves as above; a date typed there is carried into the commit as today.

**A photo in either trash.** Exactly as today — Restore, Delete permanently in
the family's, Photo info — except a photo with no date now says "Undated", and
narrow puts the date above the caption.

**Keyboard, with focus outside the form:**

| Key                  | Read view                                     | Edit view                                          |
| -------------------- | --------------------------------------------- | -------------------------------------------------- |
| Escape               | Close info panel, else close photo            | Close info panel, else nothing if unsaved, else read view |
| ArrowLeft/Right      | Step (read view on arrival)                   | Nothing                                            |
| Delete/Backspace     | Delete where `canTrash`                       | Delete where `canTrash`; next photo in read view   |
| ⌘/Ctrl+Enter         | —                                             | In the caption: Save, if enabled                   |

There is no keyboard shortcut for Edit; the owner declined one.

## 6. Implementation notes

### 6.1 `src/shared/ui/Lightbox.tsx`

- New state, each keyed by photo ID: `editingFor` (decision 17),
  `savedFor` with its timer (decision 10), `expandedFor` (decision 6).
  `const editing = editable && editingFor === photo.id`.
- Root class: `lightbox--editing` only when `editing`.
- Bottom stack: `editing ? <EditForm …/> : <read-only block>`. The read-only
  block now renders for every context: date line always (decision 3),
  caption with clamp and More/Less when present.
- Arrow buttons: not rendered when `editing`. `step` returns early when
  `editing`.
- Action row: Download only when `!editing`; Edit (`type="button"`) only
  when `editable && !editing`; Delete, Restore, Delete permanently, Photo
  info as today.
- Escape: add rules 3 and 4 of decision 15 to the `case 'Escape'` branch.
  `dirty` and `editing` join the effect's dependency list.
- "Saved" note: under the action row, in the read view, with `role="status"`
  (implementer's discretion on the element).
- The clamp's More button needs to know whether the caption overflows.
  Measure `scrollHeight > clientHeight` in a layout effect, re-measured by a
  `ResizeObserver` (the line count changes at the breakpoint and with the
  window), and only while collapsed. `aria-expanded` on the button.
- Rewrite the header comment (~line 78): it describes the stack as "the edit
  form" under any context with `edit`.

### 6.2 `src/shared/ui/EditForm.tsx`

- Labels: "Date", "Time", "Caption".
- New props: `onCancel()` and `onSaved()` (called after a save resolves and
  the fields are set from the stored photo). Or have the lightbox wrap
  `onSave` — implementer's discretion, as long as the form only leaves on
  success.
- Save `disabled={saving || !dirty}`; ⌘/Ctrl+Enter checks the same.
- Cancel button beside Save.
- Remove the internal `saved` state and its message (decision 10). Keep
  "Unsaved changes" and the error.
- Rewrite the header comment: it argues against a toggle; it should now say
  the form is reached by Edit, leaves on Save or Cancel, and why the arrows
  are hidden and Escape refuses while unsaved.

### 6.3 Styles

- `display.css`: the read-only block's order swap (decision 5) in the 40rem
  rule; the clamp (`display: -webkit-box; -webkit-box-orient: vertical;
  -webkit-line-clamp: 4`, 10 in the wide rule; `overflow: hidden`), and the
  expanded cap (`max-height: 50vh; overflow-y: auto`). The caption keeps
  `white-space: pre-wrap`. The More/Less button's look is implementer's
  discretion; it should read as a link, not a fourth action-row button.
- `curation.css`: the stage transition inside the 40rem rule, wrapped in
  `@media (prefers-reduced-motion: no-preference)`. Style for the Cancel
  button and the "Saved" note.
- The comments on `.lightbox__foot` / `.lightbox__bottom` in the wide rule
  ("Caption, date, Download, Photo info: one column…") gain Edit.

## 7. Traps

- **Two "Cancel" buttons.** The confirm dialog (`Confirm.tsx`) has a Cancel.
  Delete from the edit view puts both on screen. Existing e2e tests call
  `page.getByRole('button', { name: 'Cancel' })` unscoped
  (`tests/e2e/admin.spec.ts` ~line 832, in the trash, where there is no edit
  view); any new test that can have both must scope to the `alertdialog`.
- **Focus inside the form includes Save and Cancel.** Rule 1 of decision 15
  blurs on Escape when either button has focus, because
  `formRef.current.contains(active)`. That is intended; do not special-case
  the buttons.
- **The unmount `onDirtyChange(false)` is what clears `dirty`** on Cancel and
  after Save. Do not add a separate reset.
- **Geometry assertions and the transition.** A bounding box read right after
  clicking Edit catches the picture mid-slide. Run those tests with
  Playwright's `reducedMotion: 'reduce'`, or poll until the box settles.
- **`--photo-left` during the slide back.** The observer watches the stage,
  whose width changes every frame of the transition, so the read view's
  stack follows the picture. Do not switch it to observing the image (the
  existing comment ~line 236 explains why).
- **Captions are plain text.** The clamp must not change how they render:
  no markup, line breaks kept.
- **Fixture counts.** If a test needs a long caption, prefer typing one
  through the form and restoring it over adding a fixture photo; several
  tests assert per-day tile counts (e.g. `display.spec.ts`
  `#d-2026-08-02 .photo-grid__item` toHaveCount(6)).

## 8. Tests

### 8.1 Unit and component (`@vitest-environment happy-dom`)

Extend `tests/unit/curation-capabilities.test.tsx`, or add
`tests/unit/lightbox-modes.test.tsx` beside it:

- Under the family library (added here): no form on opening; Download, Edit,
  Delete, Photo info present; date line and caption as text. After Edit: the
  form, no Download, Delete and Photo info present, no Previous/Next
  buttons.
- Under the files uploading: read view has Edit and Photo info only.
- Under both trashes: no Edit, no form, unchanged actions.
- The date line reads "Undated" for a photo with no date; no caption element
  for a photo with none.
- Save disabled until a field changes; enabled after; disabled again when the
  change is typed back.
- Cancel discards: Edit, type, Cancel, Edit again shows the stored value.
- A resolved save returns to the read view and shows "Saved"; stepping
  (rerender with another photo via `onStep`) clears it and lands in the read
  view.
- A rejected save stays in the edit view with the message and the typed
  value.
- Escape ladder: edit view, nothing unsaved → read view, `onClose` not
  called; again → `onClose` once. Edit view, unsaved, focus on the dialog →
  Escape leaves the form in place and does not call `onClose`. Info panel
  open in the edit view → Escape closes the panel only.
- ArrowRight in the edit view does not call `onStep`.
- Entering Edit does not focus a field.

`tests/unit/edit-form.test.tsx`: `getByLabelText('Capture date')` →
`'Date'`. `tests/unit/lightbox-info.test.tsx` renders with no context and
should pass unchanged; confirm it does.

The clamp's More button cannot be tested under happy-dom (no layout, so
`scrollHeight` is 0); it is an e2e test.

### 8.2 End to end

`tests/e2e/display.spec.ts`, "the photo view":

- "arrows across day, month, and year boundaries": read `.lightbox__date`
  text ("August 15, 2026" → "August 2, 2026") instead of the field.
- "keeps the caption visible…": the caption as `.lightbox__caption` text in
  the read view.
- "puts the chrome in the corners…": split in two. Read view: the corner
  stack (caption, date, Download, Edit, Photo info) shares a right edge and
  ends at least 15px short of the picture's derived left edge. Edit view
  (click Edit): today's assertions — stage below the back link, form above a
  row of Delete and Photo info, whole stack clear of the picture — plus no
  Download.
- "corrects a caption, and it stays corrected": Edit, fill, Save, the read
  view shows the new caption and "Saved"; reload, read-view caption text.
- New: a long caption shows More, clamps, expands to Less, and the expanded
  caption's height is at most half the viewport; stepping and back collapses
  it. Restore the caption afterwards.
- New: Escape ladder in a real browser, including "unsaved, Escape does
  nothing".

`tests/e2e/mobile.spec.ts`:

- "the photo view puts its controls below the photo": Download, Edit, Photo
  info in one row under the image.
- New: the picture is taller in the read view than in the edit view on the
  same photograph — the point of this change.
- New: after Edit, no field is focused (`document.activeElement` is not an
  input or textarea).

`tests/e2e/admin.spec.ts`:

- Every test that reads or fills a field clicks **Edit** first, and uses
  "Date" and "Time" labels.
- "names the file and carries the edit form…": on opening, the read view with
  Download, Edit, Delete, Photo info and no fields; after Edit, the fields
  and Delete, Photo info, no Download.
- "arrows across the library, resetting the form each step": becomes Edit,
  Cancel, Next, Edit — the next photo's stored values.
- "will not step away from an edit that has not been saved": replace with
  "hides the arrows in the edit view, and Escape keeps an unsaved edit".
- "still lets an unsaved edit be abandoned deliberately": the way back
  ("← Lightbox") and Cancel both abandon; Escape does not.
- "a saved date moves the photo…": Save now returns to the read view; the
  "Saved" assertion still holds.
- The uploading-panel test (~line 700): the read view has Edit and no
  Download or Delete; Edit, fill, Save.
- "opens a photo on the signed preview, with no way to edit it": add no Edit
  button.

Run `npm run check` and `npm run test:e2e` (all three projects).

## 9. Documentation updates

Make these in the same change.

### 9.1 `docs/design.md`

- **Family site**, the bullet beginning "A plain click or tap on a photograph
  opens it" (~line 353): the photo view opens to its date (or "Undated"),
  its caption clamped with More, and **Download**, **Edit**, **Delete** (only
  on a photograph added from this browser), and **Photo info**. **Edit**
  brings up the form — date, time, caption, **Save changes** and **Cancel** —
  with Delete and Photo info beneath and no Download, and hides previous and
  next. Save is available once something has changed and returns to the
  photograph with "Saved"; Cancel discards. Escape leaves a field, then the
  info panel, then does nothing while an edit is unsaved, then leaves Edit.
  Closing the photograph still discards. Keep the Delete, Photo info
  "Added from", and keyboard-ownership sentences.
- **Family site**, the bullet beginning "Selecting a photo opens it
  full-size" (~line 440): "the stack described above: the edit form, then
  the actions" becomes "the date, the caption, and the actions; the form
  only after Edit".
- **Admin site**: no change needed beyond what the family site now says; it
  is the same photo view.

### 9.2 `docs/decisions.md`

New heading "## The photo view opens to read — 2026-09-15" and entry **96**,
citing this spec: the owner's reason (section 1), that it reverses #41's
"always" and "No Edit toggle" at every width in both apps, and the rejected
alternatives from decisions 1, 6, 13, 14, and 20. Note that #42's "discarded
silently on … Escape" no longer holds inside the edit view (decision 15).
Mark #41 and #42 as amended by #96 if the file has a convention for that;
otherwise the new entry is enough.

### 9.3 `docs/specs/family-tier.md`

At the top of section 5.3, one line: "Amended by
`docs/specs/read-first-photo-view.md`: the lightbox opens read-only, and the
form is behind Edit."

### 9.4 Code comments

The header comments of `Lightbox.tsx` and `EditForm.tsx` (sections 6.1, 6.2),
and the two CSS comments in section 6.3.

## 10. What does not change

- No server, route, Function, Worker, or fixture-server change. Nothing about
  what may be edited, trashed, or restored.
- `Capabilities` keeps its eight flags.
- Tile gestures in both apps (click-to-select, double-click to open in the
  admin; tap to open in the family app).
- Photo info's contents, including "Capture date", "Added from", and
  "Emailed by".
- The confirm dialog, Undo, the advance-after-delete order, and the bulk
  caption bar.
- The edit form's behaviour when the stored record changes under it
  (decisions.md #89, `edit-form.test.tsx`).
- The trash's actions.
