# Applying one caption to a selection

Spec, 2026-09-11. Written after a design interview; the decisions below are
settled unless marked "implementer's discretion". A separate agent implements
this, starting from no knowledge of the interview. Where this spec and the code
disagree, the spec wins; where it and `docs/design.md` disagree, the spec wins
and the doc is updated (section 11).

Line numbers cited here were correct when it was written. Treat them as
pointers and search for the named symbol if one has drifted.

## 1. Outcome

In the admin's library and its Recently added view, the selection bar gains a
one-line **caption box** labelled **Apply caption to selected**, at the bar's
right-hand end. Applying replaces the caption of every selected photograph
with the box's text. A confirmation appears only when some photograph would
lose a different caption, and it lists each of those photographs with its
thumbnail and the caption it would lose. A five-second Undo follows every
apply that changed anything.

The viewer does not change. The trash does not change. The upload panel does
not change. Today `docs/design.md` says "Bulk delete is the only bulk action;
date, time, and caption are per-photo", and this makes caption the second bulk
action.

## 2. Where things stand today

Read these before starting; the design leans on each.

- **Selection and the bar live in `src/admin/App.tsx`.** `selection` state
  (`:137`), pruned to what is on screen on every render (`:175`, `chosen`), and
  the bar rendered only while `chosen.length > 0` (`:386-399`). Because the bar
  is unmounted when nothing is selected, any state held inside it resets when
  the selection empties. Section 5 relies on that.
- **`src/admin/components/SelectionBar.tsx`** renders, in order: the count,
  its `children` (today the red **Delete selected** button), then **Deselect
  all**. It is a left-aligned, wrapping flex row (`.selection-bar`,
  `src/shared/styles/admin.css:312`), `position: fixed`, `z-index: 4`, and it
  publishes its own height to `--selection-bar-height`.
- **The trash has its own bar** (`src/admin/components/TrashPage.tsx:266`,
  Restore and Delete permanently). Leave it alone.
- **Decision #36 in `docs/decisions.md`: no control is ever shown disabled.**
  A control is present when it has something to do and absent otherwise.
- **Order on screen.** `orderedIds` in `App.tsx:167` is the order the current
  view shows photographs (library order, or Recently added order).
  `selectedIds()` (`src/admin/selection.ts:124`) returns *insertion* order, not
  screen order. `indexTimeline(data).photos` (`src/shared/ui/timeline-index.ts`)
  maps every live photo ID to its `PublicPhoto`. The Recently added groups in
  `TimelineResponse.recent` carry IDs only, never photo copies.
- **The grid does not show captions.** A tile is a thumbnail and, in the
  admin, a filename. A caption change is invisible on the page unless the
  photo view is opened.
- **Per-photo editing.** `src/shared/ui/EditForm.tsx` is the photo view's form:
  date, time, and a three-row caption `<textarea>` where Enter inserts a line
  break and Cmd/Ctrl+Enter saves. It is mounted by `src/shared/ui/Lightbox.tsx:528`
  with `key={photo.id}` and initialises its fields from `photo` once
  (`EditForm.tsx:43-45`). The photo view is `position: fixed; z-index: 10`
  (`src/shared/styles/display.css:498`) and covers the selection bar.
- **The edit path.** `App.tsx:251` `saveEdit` → `adminApi.edit`
  (`src/admin/api.ts:257`) → `POST /edit` → `handleEdit`
  (`netlify/functions/admin.ts:430`) → `editPhotoMetadata`
  (`src/shared/admin-operations.ts:153`) under `mutateCatalog`
  (`src/shared/catalog-repository.ts:106`, a conditional write that re-runs the
  pure mutation from scratch on conflict) → one `metadata-change` audit event
  written *after* the catalog write. The page then patches its copy of the
  timeline from the reply and calls `refetch()`.
- **The fixture server mirrors every admin route.** `config/fixture-server.ts:855`
  handles `/edit` with the same shared mutation and writes no audit. CLAUDE.md
  warns that a route added only to the fixture server has shipped as a bug;
  add the new route to **both** `netlify/functions/admin.ts` and the fixture
  server.
- **Confirmation.** `ConfirmDialog` (`src/admin/components/Confirm.tsx:24`) is
  modal with `role="alertdialog"`. It focuses its confirm button on mount,
  Escape or a backdrop click cancels, and it wraps its `children` in a `<p>`.
  It does not restore focus when it closes.
- **Undo.** `UndoBanner` (`Confirm.tsx:149`) withdraws itself after five
  seconds and has `role="status"`. `App.tsx:143` holds
  `undo: { ids, message } | null`; `performUndo` (`:237`) calls
  `adminApi.restore`. The banner is keyed at `App.tsx:440` so that a second
  offer within five seconds gets a fresh clock rather than inheriting the old
  one (decision #46).
- **Errors.** `App.tsx:409` renders `error` as a fixed banner, `role="alert"`.
- **Escape.** `src/admin/deselect.ts` listens on `window`. Escape clears the
  selection unless a dialog is open or `document.activeElement` is an input,
  textarea, or select.
- **Timeline patching.** `upsertPhoto` (`src/shared/timeline-patch.ts:177`)
  removes a photo and re-inserts it where its date says. A date-only photo is
  appended after its day's timed photos, so using it for a caption-only change
  would visibly move date-only photos until the refetch lands.
- **Captions.** `normalizeCaption` (`src/shared/validation.ts:31`) normalises
  line endings, strips control characters, trims, and returns `null` for an
  empty or whitespace-only string. `MAX_CAPTION_LENGTH` is 2000. Stored
  captions are always already normalised.
- **Thumbnails.** A tile's image URL is
  `derivativeUrl(__WORKER_BASE_URL__, photo.id, 'thumb')`
  (`src/shared/ui/PhotoGrid.tsx:342`; `derivativeUrl` is in `src/shared/urls.ts`).
  The dimensions are in `photo.derivatives.thumb`.

## 3. Vocabulary

- **Caption box** — the one-line `<input type="text">` in the bar.
- **Apply slot** — the fixed-width space immediately after the caption box.
  It holds nothing, the **Apply** button, the text **Applying…**, or the text
  **Applied**.
- **The new caption** — `normalizeCaption(box text)`.
- **A photo that would lose its caption** — a selected photo whose stored
  caption is non-null and not exactly equal to the new caption. Comparison is
  exact string equality after normalisation, so `beach` and `Beach` differ.
- **The bar's lifetime** — from the moment the selection becomes non-empty
  until it becomes empty again (the bar unmounts).

## 4. What the administrator sees

### 4.1 The Apply slot

Evaluated on every render, in this order:

| Condition                                                                                                                                                    | Slot shows      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- |
| A request from this box is in flight                                                                                                                         | `Applying…`     |
| The new caption is `null` (box empty or whitespace)                                                                                                          | nothing         |
| This bar has completed at least one successful apply during its lifetime, **and** every selected photo's stored caption equals the new caption | `Applied`       |
| Otherwise                                                                                                                                                    | **Apply** button |

`Applied` is a confirmation of something the administrator did, not a
description of the photos (decision 9). So selecting four photos that already
say `Beach` and typing `Beach` shows **Apply**. Pressing it sends nothing and
shows `Applied`.

### 4.2 Scenarios

**Captioning photos that have none.** Select 12 photos with no caption, type
`Beach, July 2019`, press Enter (or click Apply). No dialog. All 12 get the
caption. The box keeps the text, the slot shows `Applied`, and the banner reads
"Caption applied to 12 photos." with **Undo** for five seconds.

**Replacing captions.** 40 photos selected: 22 have no caption, 3 already say
`Beach, July 2019`, and 15 have other captions. Press Enter. A dialog opens:

> **Replace captions?**
> Apply "Beach, July 2019" to 40 photos? 15 of them have a different caption,
> which will be replaced:
>
> _(a scrolling list of 15 rows, each a small thumbnail beside that photo's
> current caption, shown in full with its line breaks, in on-screen order)_
>
> [Cancel] [**Replace captions**]

Confirm: 37 photos change, and the banner reads "Caption applied to 37
photos." Cancel: nothing changes, the box keeps its text, and focus returns to
the box.

**Adding the ones you missed.** After applying to 12, Cmd-click three more.
`Applied` becomes **Apply** because the three don't match, and the box still
holds `Beach, July 2019`. Enter applies to the three.

**Closing the bar.** Deselect all, Escape (with focus outside the box), or a
click on the page margin empties the selection. The bar unmounts, and the next
selection opens with an empty box.

**Undo.** Each photo that changed gets back its own previous caption, `null`
included. A photo whose caption was changed again after the apply (in the
photo view, or another tab) is left with its newer caption. Undo has no
confirmation. Afterwards the slot shows **Apply** again, which follows from
4.1.

**Escape inside the box.** The first Escape blurs the box and leaves the
selection alone. A second Escape, with focus now outside the box, clears the
selection as it does today.

## 5. Decisions

Numbered so the implementation and the docs can cite them.

1. **Apply replaces.** Every selected photo ends up with exactly the new
   caption. Rejected: appending after or before the existing caption, which
   can push a caption past `MAX_CAPTION_LENGTH` and needs a rule for that.
   Rejected: filling only blank captions, which quietly skips photos someone
   selected on purpose. Rejected: offering both modes each time.

2. **Nothing can be applied from an empty box.** Captions are cleared one
   photo at a time in the photo view. Rejected: an empty box clears every
   selected caption, because Enter in an empty box would then wipe them all.
   Rejected: a separate "Remove captions" button, for a need that is rare and
   already served per photo. The server still accepts `null` as a caption,
   because Undo has to put back "no caption" (section 7).

3. **One line, and Enter applies.** An `<input type="text">`, so bulk captions
   cannot contain line breaks; add those per photo afterwards. Rejected: a
   three-row box like the photo view's, which makes the pinned bar three lines
   taller. Rejected: a one-line box that grows on Shift+Enter. The photo view
   uses the opposite convention (Enter is a new line, Cmd+Enter saves), so
   pressing Enter from photo-view habit would apply a half-typed caption to
   every selected photo. Changing the photo view's convention is out of scope
   (section 12).

4. **The Apply button exists only while the box holds text** (#36). Enter does
   the same thing. Rejected: Enter only, which a mouse user would never
   discover. Rejected: a button that is always present and sometimes does
   nothing.

5. **Confirm only when a caption would be lost, and show each such photo.** If
   no selected photo would lose a caption (section 3), apply immediately. If
   any would, the dialog of 4.2 lists one row per such photo: its thumbnail
   and its current caption, in on-screen order, scrolling when long. Rejected:
   never confirming. Rejected: always confirming with a count. Rejected: a
   list truncated to the first few, which hides part of what is lost.
   Rejected: one row per distinct caption with a count. Accepted knowingly: a
   selection that accidentally caught many *uncaptioned* photos is not caught
   by a dialog, and Undo is the net for that.

6. **A five-second Undo, under #46's rules.** It uses the same banner and the
   same clock. It is replaced by any later offer (a delete or another apply)
   inside the five seconds, and nothing else withdraws it. Undo restores each
   changed photo's previous caption, conditional on the photo still having the
   caption that was applied (decision 12). Rejected: no Undo. Rejected: an
   offer that lasts until the next change, which is a behaviour nothing else
   in the app has.

7. **`Applied` stands in the Apply slot after a successful apply**, the way
   `Saved` follows a save in the photo view's form. Rejected: no feedback,
   which leaves nothing visible because tiles show no captions. Rejected: a
   note elsewhere in the bar. Rejected: a banner alone.

8. **The box's text survives selection changes and dies with the bar.** It is
   state inside a component rendered by the bar, so the bar unmounting resets
   it for free. Rejected: emptying the box on every selection change, which
   forces retyping to add missed photos. Rejected: remembering the text until
   reload, which leaves a stale caption ready to apply to unrelated,
   uncaptioned photos with no dialog to catch it.

9. **The slot rule is 4.1: an "applied at least once" flag combined with a live
   comparison.** Rejected: purely event-driven (show `Applied` on success and
   clear it on edit or selection change), which goes stale after Undo, after a
   photo-view edit, or after a refetch. Rejected: a pure comparison with no
   flag, which shows `Applied` for a caption nobody applied.

10. **The caption box sits at the bar's right-hand end, and the Apply slot's
    width is reserved.**

    ```
    12 selected  [Delete selected]  [Deselect all]          Apply caption to selected [____________] [Apply]
    ```

    It comes after Deselect all and is pushed right with `margin-left: auto`.
    The slot is as wide as its widest state (`Apply` button, `Applying…`,
    `Applied`) whatever it currently shows, so neither the box nor anything
    else moves when the slot changes. When the window is narrow the group
    wraps onto its own line, still right-aligned. Rejected: between the count
    and the buttons, where Delete selected and Deselect all jump sideways
    whenever the slot changes and Apply sits beside the red Delete selected.
    Rejected: always on a second line.

11. **Library and Recently added only.** Both render `App.tsx`'s bar. The trash
    renders its own bar, and trashed photos are not editable
    (`editPhotoMetadata` refuses them). The upload panel has no selection.

12. **One request, one catalog write, and every change carries the caption it
    expects to replace.** `POST /captions` takes explicit
    `{ photoId, caption, expected }` changes. A change is applied only if the
    photo is live and its stored caption is exactly `expected`; otherwise it is
    skipped and reported. This is what makes decision 5's promise true (you
    were shown what would be lost, and nothing else can be lost) and what lets
    Undo leave a newer edit alone. Rejected: N calls to `/edit`, which means N
    catalog writes, N snapshots, and partial failure halfway. Rejected: the
    preview/confirm token path of #12. That exists to stop a re-run *query*
    sweeping in photos nobody saw, whereas here the IDs are explicit and the
    per-change precondition checks content as well as membership.
    Last-write-wins, the rule for `/edit`, was rejected because a bulk replace
    could overwrite a caption changed in another tab without it ever being
    shown.

13. **One audit event per request.** It uses a new action, `caption-change`,
    and carries a per-photo `before`/`after` caption list. Rejected: one
    `metadata-change` event per photo, which is N object PUTs inside a
    Function's time budget and N different `updatedAuditId`s for one act.
    Nothing in the code reads the audit log; it is a record.

14. **The page patches captions in place.** It swaps the changed records where
    they already sit and does not use `upsertPhoto`, which would move date-only
    photos (section 2).

15. **An untouched photo-view form follows the stored record.** This is needed
    because Undo's banner (`z-index: 25`) sits above the photo view
    (`z-index: 10`). Pressing Undo while the photo view shows an affected photo
    changes the stored caption under a form that was initialised from the old
    one. Today that form would then report "Unsaved changes" and lock the
    arrows. See 6.6.

## 6. Client

### 6.1 Pure helpers: `src/admin/caption-apply.ts` (new)

No React and no DOM, so every rule is unit-testable in one place. Suggested
shape (names are implementer's discretion, the behaviour is not):

```ts
export type CaptionSlot = 'blank' | 'apply' | 'applying' | 'applied';

/** Section 4.1, in that order. */
export function captionSlot(input: {
  text: string;
  inFlight: boolean;
  appliedOnce: boolean;
  /** Stored captions of the selected photos. */
  selectedCaptions: readonly (string | null)[];
}): CaptionSlot;

export interface CaptionPlan {
  /** Normalised; null means there is nothing to apply. */
  caption: string | null;
  /** One per selected photo whose caption differs, in the order given. */
  changes: { photoId: string; caption: string; expected: string | null }[];
  /** The subset of `changes` with a non-null `expected`: the dialog's rows. */
  replaced: { photo: PublicPhoto; expected: string }[];
}

/** `selected` must already be in on-screen order. */
export function planCaption(selected: readonly PublicPhoto[], text: string): CaptionPlan;
```

### 6.2 The bar

- `SelectionBar` gains an optional `trailing?: ReactNode`, rendered **after**
  Deselect all inside a wrapper with `margin-left: auto`. `TrashPage` does not
  pass it.
- A new `CaptionApply` component (`src/admin/components/CaptionApply.tsx`) is
  passed as `trailing` from `App.tsx`. It owns `text` and `appliedOnce` (reset
  by unmount, decision 8) and `inFlight`. It receives the selected photos in
  on-screen order and an `onApply(plan)` callback that returns a promise
  resolving to `'applied' | 'cancelled' | 'failed'`. Set `appliedOnce` only on
  `'applied'`.
- Markup: a visible `<label>` "Apply caption to selected" bound to the input,
  so `getByLabel` finds it; the input; then the slot. The slot uses
  `aria-live="polite"`, **not** `role="status"` (trap 10.5).
- Keys in the input:
  - **Enter**: `preventDefault()`. If the slot is `apply`, apply. Otherwise do
    nothing. Ignore Enter while `event.nativeEvent.isComposing` (IME input).
  - **Escape**: `stopPropagation()` and blur (trap 10.1).
- Selected photos in on-screen order are `orderedIds.filter(id => selected)`
  mapped through a memoised `indexTimeline(data).photos`. Do not use `chosen`'s
  order.

### 6.3 Applying (in `App.tsx`)

Given the plan from 6.1:

1. `caption === null` → return (unreachable while the slot is `blank`).
2. `caption.length > MAX_CAPTION_LENGTH` → set `error` to
   `Caption must be 2000 characters or fewer.`, send nothing, and return
   `'failed'`. Share the message with `validatePhotoEdit` rather than writing it
   twice: extract a `validateCaption` in `src/shared/validation.ts` that both
   use.
3. `changes` empty → send nothing, no banner, and return `'applied'`.
4. `replaced` non-empty → open the dialog (6.4) and wait. Cancel returns
   `'cancelled'`.
5. `adminApi.captions(changes)`. On a thrown error, set `error` to its message
   and return `'failed'`.
6. On a reply `{ updated, skipped }`:
   - Patch the timeline with `replacePhotosInPlace(data, updated)` (6.5).
   - If `updated` is non-empty, raise the Undo offer (6.7) with the message
     `Caption applied to ${photoCount(updated.length)}.` (`photoCount` is at
     `App.tsx:72`).
   - If `skipped` is non-empty, set `error` to a message saying how many
     photos changed after the page loaded, that they were left alone, and that
     applying again includes them. The exact wording is implementer's
     discretion.
   - `refetch()`, and return `'applied'`.

After the dialog closes, whichever way, return focus to the caption box.

### 6.4 The replace dialog

- Use `ConfirmDialog` with the title **Replace captions?**, the confirm label
  **Replace captions**, and `destructive`. Enter confirms, because the dialog
  focuses its confirm button.
- The sentence goes in `children` as today:
  `Apply "<caption>" to <N selected> photos? <M> of them have a different
  caption, which will be replaced:`. Use singular forms for 1. Clamp the
  quoted caption visually to a few lines with CSS; it can be up to 2000
  characters.
- The list cannot go in `children`, which is wrapped in a `<p>`. Add an
  optional `details?: ReactNode` prop to `ConfirmDialog`, rendered between the
  paragraph and the actions. Existing callers are unaffected.
- Each row: `<img src={derivativeUrl(__WORKER_BASE_URL__, id, 'thumb')} alt="">`
  sized from `photo.derivatives.thumb` scaled to a small fixed height, beside
  the current caption with `white-space: pre-wrap`. `alt=""` because the
  caption beside it is the text. The list scrolls inside the dialog. Its max
  height, and whether this dialog is wider than `.confirm`'s `26rem`, are
  implementer's discretion.
- Render the dialog from `App.tsx`'s top-level fragment, beside the existing
  `Confirm`, **not** inside the bar (trap 10.2).

### 6.5 `replacePhotosInPlace`, in `src/shared/timeline-patch.ts`

`replacePhotosInPlace(timeline: TimelineResponse, photos: readonly PublicPhoto[]): TimelineResponse`.
It replaces each photo by ID wherever it sits in `years → months → days` and
`undated`, leaving positions, counts, and groups unchanged. It ignores unknown
IDs and returns the same object when nothing matched. `recent` holds IDs only
and needs nothing. This file must stay free of DOM, Node, and Workers globals
(CLAUDE.md).

### 6.6 `EditForm` follows the stored record when untouched

For each of date, time, and caption: if the field's current value equals the
stored value the form last saw, and the stored value changes, the field takes
the new stored value. A field the administrator has actually edited keeps the
edit. Keep `key={photo.id}` exactly as it is; `EditForm.tsx:38-41` explains
why the key must not include metadata. The mechanism is implementer's
discretion (for example, remembering the last-seen record and adjusting state
when the `photo` prop changes).

### 6.7 Undo, generalised

`undo` state becomes a discriminated union:

```ts
type UndoOffer =
  | { kind: 'trash'; ids: string[]; message: string }
  | {
      kind: 'caption';
      /** Reversed changes: caption = what the photo had, expected = what was applied. */
      changes: { photoId: string; caption: string | null; expected: string }[];
      message: string;
    };
```

- `performUndo` branches on `kind`. Trash is unchanged. Caption calls
  `adminApi.captions(changes, { undo: true })`, patches in place from
  `updated`, clears the offer, and `refetch()`es. If anything came back
  `skipped`, set `error` to say how many photos kept a newer caption.
- The banner key must give every new offer a fresh five-second clock,
  including a second apply to the same photos inside the window. Keying by
  `ids.join(',')` alone does not guarantee that (trap 10.4). Use a counter
  incremented each time an offer is raised, or include `kind` and the applied
  caption in the key.
- Build the reversed `changes` from the request's `expected` values and the
  reply's `updated` IDs. Only photos that actually changed are put back.

### 6.8 API client, in `src/admin/api.ts`

```ts
captions: (
  changes: { photoId: string; caption: string | null; expected: string | null }[],
  options: { undo?: boolean } = {},
) =>
  post<{ updated: PublicPhoto[]; skipped: string[] }>('/captions', {
    changes,
    ...(options.undo ? { undo: true } : {}),
  }),
```

### 6.9 Styles, in `src/shared/styles/admin.css`

The trailing wrapper, the label, the input's width (it must shrink rather than
overflow at about 400px), the reserved slot, and the dialog's list. Exact sizes
are implementer's discretion. The requirement is decision 10: the box does not
move horizontally when the slot changes state, whenever the group fits on one
line.

## 7. Server

### 7.1 Validation, in `src/shared/validation.ts`

```ts
export interface CaptionChange {
  photoId: string;
  caption: string | null;
  expected: string | null;
}

export function validateCaptionChanges(input: unknown): ValidationResult<CaptionChange[]>;
```

The request is invalid, as a whole, if:

- `input` is not a non-empty array;
- any entry is not an object;
- any `photoId` is not a string passing `isValidPhotoId` (`src/shared/ids.ts:60`);
- any `photoId` appears twice;
- any `caption` is not a string or `null`, or exceeds `MAX_CAPTION_LENGTH`
  after `normalizeCaption`;
- any `expected` is not a string or `null`.

The returned `caption`s are normalised. `expected` is **not** normalised: it is
compared byte-for-byte with the stored value, which is already normal. Keep
this file runtime-neutral.

### 7.2 Mutation, in `src/shared/admin-operations.ts`

```ts
export type CaptionsOutcome =
  | { status: 'applied'; updated: PhotoRecord[]; previous: PhotoRecord[]; skipped: string[] }
  | { status: 'invalid'; error: string };

export function applyCaptions(
  catalog: Catalog,
  input: unknown,
  now: string,
  auditId: string,
): Mutation<CaptionsOutcome>;
```

- Validate with `validateCaptionChanges` *inside* the mutation, as
  `editPhotoMetadata` re-validates, so the fixture server cannot skip it.
  Invalid → `abortMutation({ status: 'invalid', error })`.
- For each change, in order:
  - The photo is missing or trashed → `skipped`.
  - `photo.caption !== expected` → `skipped`.
  - `photo.caption === caption` → neither updated nor skipped (a no-op).
  - Otherwise → `{ ...photo, caption, updatedAt: now, updatedAuditId: auditId }`.
    Do **not** touch `captureDate`, `captureTime`, or `timestampSource`.
- Nothing updated → `abortMutation` (no write, no snapshot), still returning
  `skipped`.
- The function is pure. `mutateCatalog` re-runs it on conflict, and the
  `expected` checks are evaluated again against the fresh catalog, which is
  the point.

### 7.3 Route, in `netlify/functions/admin.ts`

Add `case '/captions': return await handleCaptions(request);` to the POST
switch (around `:160-180`). `handleCaptions`:

1. `readJson<{ changes?: unknown; undo?: unknown }>`. A null body →
   `badRequest('A list of caption changes is required.')`.
2. `mutateCatalog(store(), { now: nowIso }, (c) => applyCaptions(c, body.changes, at, auditId))`.
3. `invalid` → `badRequest(error)`.
4. If `updated` is non-empty, write **one** audit event after the catalog write
   (the same ordering as `handleEdit`, `:445`): action `caption-change`,
   `photoIds` set to the updated IDs, `changes` set to
   `[{ photoId, before: previous.caption, after: updated.caption }]`, and
   `note: 'undo'` when `body.undo === true`.
5. `json({ updated: updated.map(toPublicPhoto), skipped })`.

Refusals from the gate stay plain 404s as before. A malformed body here is a
400, as it is for `/edit`.

### 7.4 Audit, in `src/shared/audit.ts`

- Add `'caption-change'` to `AuditAction`, with a doc comment: one event per
  bulk caption request, per-photo captions in `changes`.
- Add `changes?: { photoId: string; before: string | null; after: string | null }[]`
  to `AuditEvent`, plus the matching option and copy in `makeAuditEvent`.

### 7.5 Fixture server, in `config/fixture-server.ts`

Add `case '/captions'` beside `/edit` (`:855`). It uses the same
`applyCaptions` under `mutateCatalog`, `sendBadRequest` on `invalid`, and
otherwise `sendJson(res, 200, { updated: updated.map(toPublicPhoto), skipped })`.
It writes no audit, matching `/edit` there.

## 8. What does not change

- The viewer, the display build, and `src/display/`.
- `TrashPage`, its bar, and trash semantics.
- `Capabilities` in `src/shared/ui/curation.ts`.
- The photo view's caption field, including Enter and Cmd+Enter.
- Deleting, its dialog, and its Undo, apart from the generalised undo state in
  6.7.
- The Inbox's caption proposal (`src/shared/submissions.ts`).
- The Worker. Nothing here is in the Worker's module graph except
  `validation.ts` and `audit.ts` compiling under `tsconfig.worker.json`, so run
  `npm run typecheck`.

## 9. Deploying

Netlify only: the apps, the admin Function, and `src/shared/`. No
`wrangler deploy` is needed, because the Worker does not serve or call this
route. Do not push or deploy as part of implementing; the owner does that.

## 10. Traps

1. **Escape in the box must not reach `window`.** React's `onKeyDown` runs at
   the root container, before `deselect.ts`'s `window` listener. If the handler
   blurs the input and lets the event continue, the window listener sees no
   focused field and clears the selection on the *first* Escape. Call
   `event.stopPropagation()` (which stops the native event too) before
   blurring.

2. **The bar is a stacking context.** `.selection-bar` is `position: fixed;
   z-index: 4`. A dialog rendered inside it is confined to that layer
   regardless of its own `z-index`, underneath the error banner, the undo
   banner, and anything else above 4. Render the dialog from `App.tsx`'s
   top-level fragment.

3. **`upsertPhoto` moves date-only photos.** Use `replacePhotosInPlace` for
   caption results (decision 14).

4. **The undo banner's clock is its key.** A second apply to the same photos
   inside five seconds must restart the clock and must undo the *second*
   apply (6.7).

5. **Two `role="status"` elements break existing tests.** `tests/e2e/admin.spec.ts`
   calls `page.getByRole('status')` expecting the undo banner alone, and
   Playwright's strict mode fails when that matches two elements. The slot
   uses `aria-live="polite"`.

6. **Screen order is not selection order.** `chosen` is insertion order. The
   dialog's rows follow `orderedIds`.

7. **`ConfirmDialog` wraps `children` in `<p>`.** A list inside a paragraph is
   invalid HTML and is re-parented by the browser. Use the new `details` prop.

8. **Add the route to both servers** (section 2, CLAUDE.md).

9. **Undo can land under an open photo view** (decision 15, 6.6).

10. **Pasting multi-line text into a one-line input** removes the line breaks
    in the browser. That is the intended behaviour (decision 3), and the
    server does not need to reject newlines, because Undo legitimately restores
    multi-line captions.

## 11. Tests

### 11.1 Unit

`tests/unit/admin-operations.test.ts`, new `describe('applyCaptions')`, using
the file's existing `apply()` helper and `makeCatalog`/`makePhoto`:

- Replaces the caption of each photo whose stored caption equals `expected`.
  Sets `updatedAt` and `updatedAuditId`. Leaves `captureDate`, `captureTime`,
  and `timestampSource` untouched.
- Skips, and lists in `skipped`: an `expected` mismatch, a trashed photo, and
  an unknown ID.
- A change whose caption equals the stored caption is in neither list.
- Everything skipped or a no-op → abort (`catalog === null`).
- `caption: null` is accepted and clears (the Undo path).
- Invalid input yields `status: 'invalid'` and aborts: an empty array, a
  duplicate ID, a malformed ID, an over-length caption, a non-string caption.
- Captions are stored normalised (for example, surrounding spaces trimmed).
- Through `mutateCatalog` on `InMemoryObjectStore`: when a competing write
  lands between load and write and changes one targeted photo's caption, the
  retry skips that photo and applies the rest.

`tests/unit/timeline-patch.test.ts`, new `describe('replacePhotosInPlace')`:

- A date-only photo keeps its exact position in its day. Compare with what
  `upsertPhoto` would do, to show why this exists.
- An undated photo is replaced in place.
- Counts and groups are unchanged, and an unknown ID is ignored.

New `tests/unit/caption-apply.test.ts`:

- `captionSlot`: every row of 4.1. A whitespace-only box is `blank`. Before
  any apply, a caption every selected photo already has is `apply`; after one,
  it is `applied`. One mismatching photo gives `apply`. `inFlight` wins over
  everything.
- `planCaption`: excludes photos already equal; `replaced` holds only non-null
  different captions; `beach` vs `Beach` is replaced; input order is preserved.

`tests/unit/audit.test.ts` (new, or wherever the implementer prefers):
`makeAuditEvent` carries `changes` when given and omits it when not.

### 11.2 Component (`@vitest-environment happy-dom`)

- `EditForm`: re-render with a changed `photo.caption`. An untouched caption
  field follows it and "Unsaved changes" does not appear. A field edited
  before the change keeps the edit.
- `CaptionApply`: Enter applies only when the slot is `apply`. Escape blurs
  and does not propagate. There is no Apply button while the box is empty or
  whitespace.

### 11.3 End-to-end: `tests/e2e/admin.spec.ts`

A new `test.describe('applying a caption to a selection')`, on `scratch()`'s
day. That day has three live photos: `ids[0]` is captioned
`First rocket up.`, and `ids[1]` and `ids[2]` have no caption. The fixture
store is shared by every Playwright project and the file runs serially, so
each test must leave those three captions exactly as it found them. Use Undo,
or clean up in the test via the photo view's form or a direct POST to the
fixture's `/captions` route.

- The library bar has `getByLabel('Apply caption to selected')`, and the trash
  bar does not. No Apply button while the box is empty or holds only spaces.
  Typing shows Apply, and the box's bounding-box `x` is the same before and
  after typing the first character.
- Select `ids[1]` and `ids[2]`, type, press Enter: no `alertdialog`, the slot
  reads `Applied`, and the undo banner says `Caption applied to 2 photos.`
  Click Undo; then double-click `ids[1]` and its caption field is empty.
- Select all three (the day's Select all), type `Beach`, press Enter. The
  dialog says `3 photos` and `1 of them`, and has exactly one row, containing
  `First rocket up.` and an `img`. Cancel: nothing changed, and the box is
  focused and still holds `Beach`. Enter again and confirm with
  **Replace captions**: `Applied`. Undo: `ids[0]` is back to
  `First rocket up.` and the other two are empty.
- Apply to `ids[1]` alone, then Cmd/Ctrl-click `ids[2]`: the box still holds
  the text and the slot shows Apply. Focus the box and press Escape: the box
  is blurred and the bar still reads `2 selected`. Press Escape again: the bar
  is gone. Select a photo: the box is empty. Clean up.
- Type a caption the selected photos already have (select `ids[0]` alone and
  type `First rocket up.`): the slot shows Apply. Press Enter: no request to
  `/captions` is made (count with `page.on('request')`), the slot shows
  `Applied`, and no undo banner appears.
- Apply to `ids[1]`, double-click it to open the photo view, and click Undo
  in the banner above it: the caption field is empty and "Unsaved changes" is
  not shown.

Existing tests must pass unchanged, in particular every
`getByRole('status')` in the deleting tests (trap 10.5).

## 12. Documentation updates

### 12.1 `docs/design.md`

In the admin section, the selection bullet (around `:421-425`) currently
ends:

> While anything is selected a bar pinned to the top of the page shows the
> count, **Delete selected**, and **Deselect all**; it is absent otherwise. No
> selection control is ever shown disabled. Bulk delete is the only bulk
> action; date, time, and caption are per-photo.

Replace that with:

> While anything is selected a bar pinned to the top of the page shows the
> count, **Delete selected**, **Deselect all**, and, at its right-hand end, a
> caption box; it is absent otherwise. No selection control is ever shown
> disabled. Delete and caption are the bulk actions; date and time are
> per-photo.

and add a bullet directly after it:

> - The caption box, labelled **Apply caption to selected**, is one line.
>   Typing brings up **Apply**, and Enter does the same. The caption *replaces*
>   every selected photograph's caption. Nothing can be applied from an empty
>   box, so captions are cleared one photograph at a time. When a photograph
>   would lose a different caption, a confirmation lists each such photograph
>   with its thumbnail and the caption it would lose; when none would, the
>   caption applies at once. A five-second Undo follows, as it does a delete,
>   and puts back each photograph's own caption, except one changed again in
>   the meantime. After applying, **Applied** stands in place of the button
>   for as long as every selected photograph carries the text in the box. The
>   text stays while the selection changes and goes when the bar does. The
>   trash has no caption box.

### 12.2 `docs/implementation-plan.md`

Under "Admin API" (around `:344`), after "per-photo date/time/caption update;"
add: "bulk caption replacement (`POST /captions`), each change conditional on
the caption the page last saw;".

### 12.3 `docs/decisions.md`

One new numbered entry, **89**, in the file's voice, recording:

- Replace, not append or fill-blanks, and why (the length limit; silent skips).
- No bulk clearing, and that the server still accepts `null` for Undo.
- One line with Enter to apply, and the rejected Shift+Enter growing box,
  because the photo view's Enter means the opposite.
- Confirmation only when a caption would be lost, with per-photo rows; and the
  accepted cost that over-selected uncaptioned photos are caught only by Undo.
- The five-second Undo under #46, skipping photos changed since.
- `Applied` as confirmation of an act (a flag plus a live comparison), and why
  neither half alone was right.
- Placement at the right-hand end with a reserved slot, because the
  alternatives made buttons jump.
- The `expected` precondition as what makes the dialog honest, and why #12's
  token path was not reused.
- One `caption-change` audit event per request.
- The in-place patch, and `EditForm` following an untouched record.

### 12.4 Code comments

- `SelectionBar.tsx`: the `children` doc comment says "Delete selected, or
  Restore and Delete permanently". Document `trailing` beside it.
- `App.tsx:143` and the banner comment at `:428-438`: the undo offer is no
  longer trash-only.
- `EditForm.tsx:31-41`: the "initialised once" description changes with 6.6.

### 12.5 `CLAUDE.md`

No change.

## 13. Out of scope

- The photo view's caption Enter/Cmd+Enter convention. The owner may change it
  later. If it becomes Enter-saves, decision 3's one-line rule is worth
  revisiting.
- Bulk date and time.
- Bulk clearing of captions.
- Showing captions on grid tiles.
- A keyboard shortcut to focus the caption box.
- Touch-specific bulk UI (admin is laptop-oriented, per `docs/design.md`).

## 14. Implementer's discretion

- Helper and component names in 6.1 and 6.2.
- The exact wording of the skipped-photo messages (6.3, 6.7).
- The input's width, the slot's reserved width mechanism, the dialog's list
  height and width, and the thumbnail size in the dialog.
- The undo banner's keying mechanism, as long as 6.7's guarantee holds.
- The `EditForm` resync mechanism, as long as 6.6's behaviour holds.
