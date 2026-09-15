# The photo view opens to read

Spec, 2026-09-15. Written after a design interview; the decisions below are
settled unless marked "implementer's discretion". A separate agent implements
this, without the interview's context. Where this spec and the code disagree,
the spec wins. Where it and `docs/design.md`, `docs/decisions.md`,
`docs/specs/family-tier.md`, or `docs/specs/family-own-trash.md` disagree,
this spec wins and section 9 amends them.

## 1. Outcome

Two changes, shipped together.

**The photo view opens to read.** Opening a photograph shows it with as little
around it as possible: its date, its caption, and a row of buttons. Nothing is
a field. One of the buttons is **Edit**, and it brings up the editing view
that exists today — the date, time, and caption fields with Save — minus
Download. This holds at every screen width, in both apps.

Reason: on a phone the edit form sits between the picture and the buttons and
takes its height straight out of the picture's, so photographs are too small.
More broadly, the owner misses the plain view the site had before the family
could edit (family-tier.md): the view people see most of the time should be
mostly read-only, because it is cleaner to look at. Editing becomes a
deliberate step. This reverses decisions.md #41, which put the form in the
photo view "always" with "no Edit toggle: editing is what an administrator is
there for, and a toggle puts a click in front of every correction." The owner
accepts that click, for the administrator too.

**The family edits only what it added.** Edit follows exactly the rule Delete
already follows: in the family app it is offered, and the server allows it,
only for a photograph added through the family link from the same browser.
The administrator edits everything, as today. This reverses
family-own-trash.md #7 ("Editing is unchanged. Anyone with the family link can
edit any photograph's date, time, and caption").

What the second change deliberately gives up, accepted by the owner:

- The family can never edit anything already in the library before uploader
  tokens existed, anything the administrator uploaded, or anything accepted
  from the Inbox — including a photograph a family member emailed in
  themselves. Adding from the Inbox happens in the admin app, which never
  records an uploader, and nothing links an email sender to a browser.
- A photograph added from one device cannot be edited from another, or after
  the browser's storage is cleared.
- Nobody but the administrator can date an undated photograph they did not
  add. design.md's "Anyone with the family link can later assign or correct a
  date" goes.

## 2. Where things stand today

Line numbers are approximate; search for the quoted text.

### 2.1 The photo view

- **One photo view for everything.** `src/shared/ui/Lightbox.tsx` is rendered
  by `PhotoPage.tsx` (library and Recently added, one route per photo),
  `TrashPage.tsx` (local state, no route), and `Upload.tsx` (files still
  uploading, local state, no route). Both apps use it.
- **What it may do comes from the curation context,** `src/shared/ui/curation.ts`.
  `Capabilities` has eight flags; the table in its doc comment (~line 63)
  lists them per listing. `edit` is a boolean. `trash` is
  `'all' | 'own' | 'none'`, decided per photograph by
  `canTrash(curation, photoId)` (~line 121), which for `'own'` asks
  `curation.addedHere(photoId)`.
- **`addedHere`** in the family app is `getUploader().addedHere(id)`
  (`src/display/App.tsx` ~line 99; `src/shared/ui/uploader.ts` ~line 49): the
  IDs this browser committed, kept in local storage. The admin's answers
  false. The upload panel's (`Upload.tsx` ~line 276) answers the app's
  `addedFrom` flag, because everything in it is on its way in from this
  browser.
- **Where each listing sets `can.edit: true`:** `src/display/App.tsx`
  ~line 101, `src/admin/App.tsx` ~line 245, `src/shared/ui/Upload.tsx`
  ~line 280. `TrashPage.tsx` ~line 237 sets `false`. The only reader is
  `Lightbox.tsx` ~line 107: `const editable = curation?.can.edit ?? false`.
- **`editable`** decides two things today: the root class
  `lightbox lightbox--editing` (~line 418), and whether the bottom stack
  renders `<EditForm>` or the read-only `.lightbox__meta` block
  (~lines 541–559).
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

### 2.2 The server

- **`netlify/functions/lib/curation-routes.ts`** answers the curation routes
  for both Functions. Ownership for trash, restore, and permanent delete is
  `reachOf(context)` (~line 187: `{ kind: 'all' }` in admin mode,
  `{ kind: 'owned', hash }` in display mode with a valid `x-photo-uploader`
  token, `null` without one) and `reaches(reach, photo)` (~line 193). The
  check runs **inside** the `mutateCatalog` callback so a conflict retry
  re-checks against the reloaded catalog; see `handleRestore` (~line 559),
  which returns `abortMutation(null)` and then the plain 404.
- **`handleEdit`** (~line 447) does no ownership check: any valid photo ID
  from either mode is edited through `editPhotoMetadata`
  (`src/shared/admin-operations.ts` ~line 160).
- **The dev fixture server** (`config/fixture-server.ts`) does not call
  `curation-routes.ts`; `handleCuration` (~line 703) reimplements each route
  over the real mutation functions, with its own `reaches` (~line 717). Its
  `/edit` branch (~line 857) has no ownership check either.
- **Fixtures.** `fixtures/catalog.ts`: only the scratch-day photographs
  (July 4th and 5th, 2026, ~line 63) carry `FIXTURE_UPLOADER_HASH`; every
  other fixture photograph is owned by nobody.

## 3. Vocabulary

- **Photo view** — the `Lightbox` component, whatever it is showing.
- **Owned** — added through the family link from this browser: the server's
  `reaches`, the page's `addedHere`. In the admin every photograph counts as
  reachable; nothing is "owned".
- **Editable photograph** — one the context can edit: `canEdit(curation, id)`
  (section 6.4). Every photograph in the admin's library and Recently added;
  owned photographs in the family's; every file still uploading, in both
  apps; nothing in either trash.
- **Read view** — what the photo view shows on opening: date line, caption,
  action row. No fields.
- **Edit view** — the form, reached by Edit.
- **Unsaved** — the form's existing `dirty`: a field differs from the stored
  record.
- **Narrow / wide** — below / at or above the existing 40rem breakpoint.
  Nothing in this spec _behaves_ differently by width; only layout,
  caption order, and the clamp's line count do.

## 4. Decisions

### 4.1 The read view and the edit view

1. **Every photo view opens in the read view, at every width, in both
   apps.** Supersedes decisions.md #41's "always" and "No Edit toggle".

   Rejected: narrow screens only. An iPhone in landscape is wider than 40rem
   (844px for an iPhone 12, 667px for an SE), so a phone would switch
   behaviours on rotation, and the owner wants the clean view on laptops too.
   Rejected: by device (`isPhoneBrowser()`). Rejected: family only.

2. **The read view's action row is Download, Edit, Delete, Photo info**, each
   as the capabilities allow, in that order. Edit appears exactly where
   `canEdit` is true (decision 22). So:

   | Listing                         | Read view row                                                 |
   | ------------------------------- | ------------------------------------------------------------- |
   | Family library / Recently added | Owned: Download, Edit, Delete, Photo info. Otherwise: Download, Photo info |
   | Admin library / Recently added  | Download, Edit, Delete, Photo info                            |
   | Either app's files uploading    | Edit, Photo info                                              |
   | Either trash                    | Unchanged: Restore, Delete permanently where `can.purge`, Photo info |

   Photo info stays in the read view because "Added from" exists to explain
   a missing Delete (family-own-trash.md #4) — and now a missing Edit — and
   that question is asked in the read view.

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
    with up to four buttons in its vertical column, Photo info still lowest.
    The picture slides right when Edit opens (the stage's `left` goes from
    the page margin to 21rem) and back on return: transition it, about 200ms
    (implementer's discretion), and not at all under
    `prefers-reduced-motion: reduce`.

    Rejected: an instant jump (the owner prefers the slide); floating the form
    over the picture so it never moves.

21. **Narrow layout: nothing new.** The read view is today's column with the
    read-only block and a one-row action row. The edit view is today's
    column: the form above a row of Delete and Photo info. The picture shrinks
    while editing; that is accepted, since editing is now brief and
    deliberate.

### 4.2 Who may edit

22. **Edit is offered exactly where Delete is, in the family's library and
    Recently added.** `Capabilities.edit` becomes `'all' | 'own' | 'none'`,
    with a `canEdit(curation, photoId)` beside `canTrash` that answers the
    same way. Values:

    | Listing                         | `edit` (was)    | `trash` (unchanged) |
    | ------------------------------- | --------------- | ------------------- |
    | Family library / Recently added | `own` (`true`)  | `own`               |
    | Family uploading                | `all` (`true`)  | `none`              |
    | Family trash                    | `none` (`false`)| `none`              |
    | Admin library / Recently added  | `all` (`true`)  | `all`               |
    | Admin uploading                 | `all` (`true`)  | `none`              |
    | Admin trash                     | `none` (`false`)| `none`              |

23. **Files still uploading stay editable, in both apps.** Every one of them
    is on its way in from this browser, so the ownership rule is met; Delete
    is missing there for a different reason (no catalog record yet). This
    keeps typing a date or caption while the phone is still uploading. A
    correction made after that file's commit is an ordinary `/edit` on a
    photograph whose commit recorded this browser's hash, so the server
    allows it (decision 24).

    Rejected: no Edit there either, which would have applied "the same rule
    as Delete" literally and lost the feature.

24. **The server enforces it.** In display mode, `/edit` reaches only an
    owned photograph, through the same `reachOf` / `reaches` check as trash
    and restore, run inside the `mutateCatalog` callback. A display-mode edit
    with no valid token, or of a photograph not owned — live, trashed,
    unknown, or malformed — is the same plain 404. The ownership check comes
    **before** body validation, so an invalid date on someone else's
    photograph is a 404, not a 400: a distinguishable response would be a
    probe oracle. Admin mode is unchanged. The page hiding Edit is not the
    reason an edit is refused.

    Rejected: hiding the button only, leaving the route open to a hand-made
    request. It breaks the rule the trash follows.

25. **What the family cannot edit, it cannot edit anywhere.** Emailed
    submissions, the pre-token library, admin uploads, and another device's
    uploads are the administrator's alone to correct (section 1). There is no
    "unclaimed photographs are editable" exception.

    Rejected: letting the family edit photographs with no uploader hash while
    protecting other browsers' uploads. The Edit and Delete rules would then
    differ, which is what the owner asked to avoid.

## 5. Scenarios

**A family member on an iPhone taps a photo they added.** The photo fills
most of the screen. Under it: "August 2, 2026", the caption clamped to four
lines with More if it runs longer, and one row: Download, Edit, Delete, Photo
info. Next/previous arrows are either side of the picture. They tap Edit: the
picture shrinks, and the form appears with Date, Time, Caption, **Save
changes** (disabled), **Cancel**, and below it Delete and Photo info; the
arrows are gone; no keyboard pops up. They tap the caption, type, tap Save.
The read view returns with the new caption and "Saved" under the buttons for
a few seconds. They tap next: the next photo, read view, no "Saved".

**The same person taps a photo someone else added, or one they emailed in.**
The read view has Download and Photo info only. Photo info says "Added from:
Another device". A hand-made `/edit` request for it gets the plain 404.

**The same person taps Edit, types, then swipes back.** The photo closes and
the typing is lost, as today.

**An undated photo with no caption.** The read view shows "Undated" and the
row; nothing else. In the family app, if this browser did not add it, nobody
there can date it.

**The administrator on a laptop double-clicks a tile.** The corner layout: the
filename at the top right, and at the bottom left, right-aligned beside the
picture, caption then date, then Download, Edit, Delete, Photo info stacked.
Click Edit: the picture slides right, the form fills the 21rem gutter with
Delete and Photo info across one row beneath it, and the arrows disappear.
They type a caption, press Escape (the field blurs), press Escape again:
nothing happens, "Unsaved changes" is showing. They click Cancel: the picture
slides back, the old caption shows. Escape now closes the photo.

**A file still uploading.** Its read view offers Edit and Photo info. Edit
behaves as above; a date typed there is carried into the commit as today, or
saved as an ordinary edit once the file has committed.

**A photo in either trash.** Exactly as today — Restore, Delete permanently in
the family's, Photo info — except a photo with no date now says "Undated", and
narrow puts the date above the caption.

**Keyboard, with focus outside the form:**

| Key              | Read view                          | Edit view                                                 |
| ---------------- | ---------------------------------- | --------------------------------------------------------- |
| Escape           | Close info panel, else close photo | Close info panel, else nothing if unsaved, else read view |
| ArrowLeft/Right  | Step (read view on arrival)        | Nothing                                                   |
| Delete/Backspace | Delete where `canTrash`            | Delete where `canTrash`; next photo in read view          |
| ⌘/Ctrl+Enter     | —                                  | In the caption: Save, if enabled                          |

There is no keyboard shortcut for Edit; the owner declined one.

## 6. Implementation notes

### 6.1 `src/shared/ui/Lightbox.tsx`

- New state, each keyed by photo ID: `editingFor` (decision 17),
  `savedFor` with its timer (decision 10), `expandedFor` (decision 6).
  `const editable = curation ? canEdit(curation, photo.id) : false;`
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

### 6.4 Capabilities, `src/shared/ui/curation.ts`

- `edit: 'all' | 'own' | 'none'`, documented like `trash`.
- `export function canEdit(curation: Curation, photoId: string): boolean`,
  the same shape as `canTrash`: `'all'` → true, `'own'` →
  `curation.addedHere(photoId)`, `'none'` → false. Whether the two share a
  helper is implementer's discretion.
- Update the doc comment's table and prose (decision 22), including "Both
  libraries edit and download".
- Set the values at `src/display/App.tsx`, `src/admin/App.tsx`,
  `src/shared/ui/Upload.tsx`, and `TrashPage.tsx` per decision 22. The
  upload panel's `'all'` is unconditional; do not route it through its
  `addedHere`, which is false in the admin.
- The `Curation.edit` implementations do not change; the server refuses.

### 6.5 Server, `netlify/functions/lib/curation-routes.ts`

`handleEdit` takes the whole `CurationRequest`, like `handleRestore`:

1. `const reach = await reachOf(context); if (reach === null) return notFound();`
2. Read the body; a missing or malformed `photoId` stays the plain 404.
3. Inside the `mutateCatalog` callback, before `editPhotoMetadata`: if
   `!reaches(reach, catalog.photos[photoId])`, `return abortMutation(null)`.
   After the call, `null` → `notFound()`. The check must be inside the
   callback so a conflict retry re-checks the reloaded catalog.
4. Validation errors (400) only for a photograph the request reaches.

Update the module's header comment (~line 27), which describes what an
uploader token reaches, and the `reachOf` section heading ("Which photographs
a trash or restore may reach").

`CLAUDE.md` is also affected; see section 9.

### 6.6 Fixture server, `config/fixture-server.ts`

The `/edit` branch (~line 857) gets the same rule with the fixture server's
own `reaches` (~line 717): a tokenless display request or an unowned
photograph is `sendNotFound`, checked inside the mutation callback and before
validation. The fixture server must answer exactly what the real Function
answers (CLAUDE.md, "Local development fake").

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
- **The whitelist tests use an unowned photograph for `/edit`.**
  `tests/unit/curation-routes.test.ts` ~line 111 posts an invalid date for
  `LIVE_ID` ("Live, and added by nobody") and expects 400 as proof display
  mode reaches the route; ~line 225 records a display-mode edit of `LIVE_ID`.
  `tests/unit/fixture-server.test.ts` ~line 86 does the same. After decision
  24 those are 404s. Switch them to `OWNED_ID` (`scratch-0-a`), which the
  unit test file already defines, or the equivalent in the fixture test.
- **The family's e2e edits use unowned photographs.** `display.spec.ts`
  ~line 696 edits `market`. Family edits must move to the scratch days, and
  the page must know it added them: see the `addInitScript` that seeds
  `photo-uploader-token` and `photo-uploaded-ids` (~line 586). Tests on
  `BASE` (the plain dev display server) that only *read* a caption or date
  need no ownership, because the read view has no fields.
- **Fixture counts.** If a test needs a long caption, prefer typing one
  through the form on an owned photograph and restoring it over adding a
  fixture photograph; several tests assert per-day tile counts (e.g.
  `display.spec.ts` `#d-2026-08-02 .photo-grid__item` toHaveCount(6)).

## 8. Tests

### 8.1 Unit and component (`@vitest-environment happy-dom`)

Extend `tests/unit/curation-capabilities.test.tsx` (its capability constants
change type with decision 22), or add `tests/unit/lightbox-modes.test.tsx`
beside it:

- Under the family library, owned (`addedHere` true): no form on opening;
  Download, Edit, Delete, Photo info present; date line and caption as text.
  After Edit: the form, no Download, Delete and Photo info present, no
  Previous/Next buttons.
- Under the family library, not owned: Download and Photo info; no Edit, no
  Delete, no form.
- Under the admin library with `addedHere` false: Edit and Delete present.
- Under the files uploading, in both apps (including the admin's, where
  `addedHere` is false): read view has Edit and Photo info only.
- Under both trashes: no Edit, no form, unchanged actions.
- `canEdit` for each of `'all'`, `'own'` (both answers), `'none'`.
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

`tests/unit/curation-routes.test.ts`, following the trash and restore tests
(~lines 387–450):

- Display mode edits an owned photograph: 200, stored, audited `display-api`.
- Display mode, unowned live photograph: 404, catalog unchanged, no audit.
- Display mode, unowned photograph with an invalid date: 404, not 400.
- Display mode, no token: 404.
- Display mode, a photograph that stops being owned between the first read
  and the conditional write: 404 (the retry re-checks), as the trash test
  "trashes nothing once the photograph has stopped being owned" does.
- Admin mode edits an unowned photograph: 200.
- The whitelist entry and the display-api audit test switched to `OWNED_ID`.

`tests/unit/fixture-server.test.ts`: the same owned/unowned/tokenless cases
for `/edit`, and its whitelist body switched to an owned photograph.

`tests/unit/edit-form.test.tsx`: `getByLabelText('Capture date')` →
`'Date'`. `tests/unit/lightbox-info.test.tsx` renders with no context and
should pass unchanged; confirm it does.

The clamp's More button cannot be tested under happy-dom (no layout, so
`scrollHeight` is 0); it is an e2e test.

### 8.2 End to end

`tests/e2e/display.spec.ts`, "the photo view" (on `BASE`):

- "arrows across day, month, and year boundaries": read `.lightbox__date`
  text ("August 15, 2026" → "August 2, 2026") instead of the field.
- "keeps the caption visible…": the caption as `.lightbox__caption` text in
  the read view.
- "puts the chrome in the corners…": split in two. Read view: the corner
  stack (caption, date, Download, Photo info, and Edit where shown) shares a
  right edge and ends at least 15px short of the picture's derived left
  edge. Edit view, on an owned scratch photograph with the uploader seeded:
  today's assertions — stage below the back link, form above a row of Delete
  and Photo info, whole stack clear of the picture — plus no Download.

`tests/e2e/display.spec.ts`, the family block (`familyBase()`):

- "corrects a caption, and it stays corrected": on an owned scratch
  photograph. Edit, fill, Save, the read view shows the new caption and
  "Saved"; reload, read-view caption text. Restore the caption.
- New: an unowned photograph (`market`) shows no Edit and no Delete, and a
  `/edit` POST for it with the fixture token is a 404.
- New: a long caption shows More, clamps, expands to Less, and the expanded
  caption's height is at most half the viewport; stepping and back collapses
  it. Restore the caption afterwards.
- New: the Escape ladder in a real browser, including "unsaved, Escape does
  nothing".

`tests/e2e/mobile.spec.ts`:

- "the photo view puts its controls below the photo": Download and Photo
  info in one row under the image (plus Edit on an owned photograph).
- New: the picture is taller in the read view than in the edit view on the
  same owned photograph — the point of this change.
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
- New: the admin sees Edit on a photograph no browser owns (e.g. `market`).

Run `npm run check` and `npm run test:e2e` (all three projects).

## 9. Documentation updates

Make these in the same change.

### 9.1 `docs/design.md`

- **Access and privacy model** (~line 46): "Anyone holding it can view, add,
  and edit photographs, and trash, restore, …" becomes: anyone holding it
  can view and add photographs, and edit, trash, restore, and permanently
  delete the photographs added from their own browser.
- **Family site** intro (~line 281): "add to it, correct it, and move the
  photographs added from their own browser to the trash and back" becomes
  "add to it, and correct, trash, and restore the photographs added from
  their own browser".
- **Family site**, the in-flight tiles bullet (~line 342): unchanged in
  substance; a file on its way in is still editable.
- **Family site**, the bullet beginning "A plain click or tap on a photograph
  opens it" (~line 353): the photo view opens to its date (or "Undated"),
  its caption clamped with More, and **Download**, **Edit** and **Delete**
  (both only on a photograph added from this browser), and **Photo info**.
  **Edit** brings up the form — date, time, caption, **Save changes** and
  **Cancel** — with Delete and Photo info beneath and no Download, and hides
  previous and next. Save is available once something has changed and
  returns to the photograph with "Saved"; Cancel discards. Escape leaves a
  field, then the info panel, then does nothing while an edit is unsaved,
  then leaves Edit. Closing the photograph still discards. "So a missing
  Delete explains itself" becomes "so a missing Edit and Delete explain
  themselves". Keep the keyboard-ownership sentences.
- **Family site**, the bullet beginning "Selecting a photo opens it
  full-size" (~line 440): "the stack described above: the edit form, then
  the actions" becomes "the date, the caption, and the actions; the form
  only after Edit".
- **Family site**, Undated (~line 458): "Anyone with the family link can
  later assign or correct a date" becomes "The administrator, or whoever
  added the photograph from the same browser, can later assign a date."
- **Family site**, "What the family does not have": add editing a
  photograph added from another browser, by email, or by the administrator.
- **Admin site**: no change needed beyond what the family site now says; it
  is the same photo view, and the administrator edits everything.

### 9.2 `docs/decisions.md`

New heading "## The photo view opens to read, and the family edits only what
it added — 2026-09-15", with two entries citing this spec:

- **96** — the read view: the owner's reason (section 1), that it reverses
  #41's "always" and "No Edit toggle" at every width in both apps, and the
  rejected alternatives from decisions 1, 6, 13, 14, and 20. Note that #42's
  "discarded silently on … Escape" no longer holds inside the edit view
  (decision 15).
- **97** — editing narrowed to ownership: it reverses family-own-trash.md
  #7, the server enforces it (decision 24, including the check before
  validation), files uploading stay editable (decision 23), and what the
  family gives up, including emailed submissions (decision 25).

Mark #41, #42, and #92 as amended if the file has a convention for that;
otherwise the new entries are enough.

### 9.3 Specs

- `docs/specs/family-tier.md`, top of section 5.3: "Amended by
  `docs/specs/read-first-photo-view.md`: the lightbox opens read-only, the
  form is behind Edit, and the family edits only what it added."
- `docs/specs/family-own-trash.md`: after decision 7, "(Reversed by
  `docs/specs/read-first-photo-view.md` #22–25: the family edits only what
  it added.)"; in section 13, strike "Narrowing who may edit" with the same
  pointer.

### 9.4 `CLAUDE.md`

The paragraph "In display mode a trash, restore, or permanent delete reaches
only photographs whose `uploaderHash` matches…" gains edit: "an edit, trash,
restore, or permanent delete".

### 9.5 Code comments

The header comments of `Lightbox.tsx` and `EditForm.tsx` (sections 6.1,
6.2), the `Capabilities` doc comment (6.4), the `curation-routes.ts` comments
(6.5), and the two CSS comments in section 6.3.

## 10. What does not change

- No new route, and no change to what admin mode may do. No Worker change.
- `Capabilities` keeps eight flags; only `edit`'s type changes.
- The upload flow, including a commit's recorded uploader hash and the
  queue's carry-into-commit edit.
- Tile gestures in both apps (click-to-select, double-click to open in the
  admin; tap to open in the family app).
- Photo info's contents, including "Capture date", "Added from", and
  "Emailed by".
- The confirm dialog, Undo, the advance-after-delete order, and the admin's
  bulk caption bar.
- The edit form's behaviour when the stored record changes under it
  (decisions.md #89, `edit-form.test.tsx`).
- The trash's actions.
