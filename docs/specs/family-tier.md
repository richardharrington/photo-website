# Letting the family add photos

Spec, 2026-09-14. Written after a design interview; the decisions below are
settled unless marked "implementer's discretion". A separate agent implements
this, without the interview's context, so this document is meant to be
complete. Where this spec and the code disagree, the spec wins; where it and
`docs/design.md` disagree, the spec wins and the doc is updated (section 12).

Decisions 3 and 6, the trash in sections 5.3 and 5.4, and the Trash link in
5.1 are amended by `family-own-trash.md`: the family trashes, restores, and
sees in the trash only photographs added from the same browser.
Decision 4's permanent deletion is amended by section 15 of that spec: the
family also deletes permanently, from its trash, what it added from the same
browser.

## 1. Outcome

The display link becomes the family link. Anyone who holds it can add
photographs, correct any photograph's date, time, or caption, move any
photograph to the trash, and look in the trash and restore from it. What was
the "display site" is now the family's site, and the admin site is that plus
four things only the administrator does: permanent deletion, the Inbox, the
Emails page, and the catalog export, along with the selection machinery and
its bulk actions.

There is still no third link. The family already holds the display link and
passes it between themselves, and a per-person link was rejected outright:
the owner does not want to manage links, and family members should be able
to forward theirs. Two opaque paths, two access modes, two Vite builds, two
Netlify Functions, exactly as today.

The reasons, ranked as the owner ranked them: family members keep asking why
they cannot add photos; the admin site's selection bar, inbox, emails, and
export are clutter for someone who wants to add a few photographs; a
mis-click that trashes a photograph should be cheap to undo, which it is
because the trash is reversible; and the Emails page lists the family's
addresses, which is nobody's business but the administrator's.

What the family sees today does not go away. Every change to the display app
is an addition: an add bar under the header, a Trash link with a count, an
edit form and Delete in the lightbox, Restore in the trash's lightbox. Plain
click still opens a photograph. No filename appears on a tile.

Mode names do not change. The gate still assigns `display` and `admin`, the
env vars are still `DISPLAY_PATH` and `ADMIN_PATH`, and `display` mode is
now allowed to mutate. Prose in the docs calls the display link "the family
link" where that reads better; code keeps the existing names.

## 2. Where things stand today

Read these before starting; the spec cites them.

- `netlify/lib/routing.ts` decides mode from the path. It does not change.
- `netlify/edge-functions/gate.ts`, `htmlHeaders(mode)`: display mode gets a
  Content-Security-Policy with no `'wasm-unsafe-eval'`, no R2 upload origin
  in `connect-src`, and no `blob:`/`data:` in `img-src`. The pipeline cannot
  run under it. This is the one gate change (section 6.4).
- `netlify/functions/display.ts` refuses every non-GET before it does
  anything else, then answers the read routes and `/download/<id>`.
- `netlify/functions/admin.ts` (about 1,300 lines) holds every mutation
  handler, the trash listing, the preview/confirm token helpers, and the
  admin-only pages' handlers, all in one file.
- `netlify/functions/lib/read-routes.ts` is the precedent for a route module
  both Functions answer, and its header comment records the bug that made it
  necessary: the fixture server was more permissive than production and hid
  a missing route.
- `src/shared/audit.ts`: `AuditEvent.via` is
  `'admin-api' | 'scheduled-maintenance' | 'email'`, and `makeAuditEvent`
  defaults it to `'admin-api'`. The handlers in `admin.ts` never pass `via`
  for curation acts; they rely on the default.
- `src/shared/ui/curation.ts`: `CurationContext` is `null` in the viewer and
  a `Curation` object in the admin. `Capabilities` has `edit`, `download`,
  `trash`, `select`. Several shared components branch on the context being
  non-null to mean "admin", listed in section 7.8.
- `src/admin/App.tsx` owns the library: fetched-plus-patched timeline,
  single-flight `refetch`, the trash preview/confirm flow, the
  delete-advances rule, the five-second undo offer (for trash and for bulk
  captions), the error banner, the trash and inbox counts, the selection, the
  caption apply, and the render of all of it.
- `src/admin/components/TrashPage.tsx` is selection-driven: click selects,
  the bar offers Restore and Delete permanently, and its own context has
  only `select` on.
- `src/admin/components/Confirm.tsx` exports `Confirm` (the preview/confirm
  dialog) and `UndoBanner`.
- `src/admin/components/Upload.tsx` is the sticky drop target and the
  in-flight tiles; `src/admin/upload/{queue,create,pending}.ts` are the queue
  and its projection into `PublicPhoto`; `src/admin/advance.ts` is the
  delete-advances rule. All of them import only from `src/shared/` and
  `src/pipeline/`, plus `src/admin/api.ts`.
- `src/admin/api.ts` wraps the shared read client and adds every mutation.
  `src/shared/ui/api.ts` resolves the API base from the `__APP_BASE__` build
  define, so a client under `src/shared/ui/` talks to its own build's base
  with nothing injected.
- `src/display/App.tsx` is about 120 lines: parse the route, one
  `useResource` for the timeline, the two listings, the photo page, no
  context provider.
- `src/shared/ui/routes.ts`, `parseRoute(pathname, base, extra)`: the admin
  passes `['trash', 'emails', 'inbox']`; the viewer passes nothing, so
  `/trash` under the display base is a 404. `src/shared/urls.ts` already
  builds `routes.trash()` for both.
- `config/fixture-server.ts`, `handle()`: for the display base, any non-GET
  is a 404 before dispatch, and `handleAdmin` answers the mutations.
- `vite.display.config.ts` and `vite.admin.config.ts` differ in root, port,
  `chunkSizeWarningLimit`, `worker.format`, and `optimizeDeps.exclude` for
  `libheif-js`. The last three exist for the pipeline.
- The decoders and encoders are already lazy (`src/pipeline/decode.ts` and
  `encode.ts` use dynamic `import()`), so the display bundle's initial script
  grows by the shared curation code only, and the 2 MB of codec code loads
  on first use.
- `docs/decisions.md` #20: Firefox is unsupported for admin, on a
  measurement from 2026-08-31, before processing became strictly serial. The
  display site was unaffected.

## 3. Vocabulary

- **Family link**, **family app**: the display path and the display build.
  Code keeps saying `display`.
- **Curation routes**: the API routes both modes may call. Section 6.1
  lists them.
- **Admin-only routes**: everything else the admin Function answers.
- **Add bar**: the sticky element under the header that opens the picker
  and accepts drops. It is the admin's `.drop-target`, reworded (section
  7.9).

## 4. Decisions

Numbered so the implementation and the docs can cite them.

1. **The display link is the family link.** No third path, no third mode,
   no per-person identity. Rejected: a per-person contributor token (owner
   does not want to manage links), a browser-remembered notion of "my
   uploads" (vanishes on a new phone, and a shared laptop defeats it), and
   handing out the admin link with a trimmed mode (everyone would need a new
   link, and the trim would be decoration since the URL still reaches every
   route).

2. **The server enforces the tier.** A display-mode request may reach the
   read routes, `/download/<id>`, and the curation routes, and nothing
   else. The UI hiding a control is never the reason a family member cannot
   do something; the Function's refusal is. The refusal is the plain 404,
   as every refusal is.

3. **Family members can upload, edit anything, trash anything, and
   restore anything.** No ownership, no "own photos". Trash is reversible
   and a mistake costs nothing; permanent deletion is the administrator's.

4. **Admin-only, and refused to display mode:** permanent-delete preview
   and confirm, bulk captions, catalog export, attribution, everything under
   `/emails` and `/inbox`.

5. **No selection in the family app.** Plain click opens, as the viewer
   does today. Editing and deleting are in the lightbox, one photograph at
   a time. Selection, the selection bar, Select all, caption apply, and the
   deselect gestures stay in `src/admin/`. Rejected for now: a Select
   switch like Photos on iOS. It is the follow-up if someone asks.

6. **Restore lives in the lightbox.** Under a context with `select` off,
   clicking a trashed photograph opens the lightbox, whose action row shows
   Restore and nothing else. The admin's trash keeps its bar and gains the
   same lightbox Restore, because it costs nothing and keeps one lightbox.

7. **Filenames stay off the family's tiles and out of the lightbox's
   top-right glance.** The family sees the original filename where it
   always has: inside Photo info. Files still uploading are the one
   exception (decision 12).

8. **`Capabilities` gains `restore` and `filename`.** Every `curation !==
   null` branch in the shared UI that means "admin" becomes a named
   capability check (section 7.8). After this change the viewer provides a
   context, so the null check stops meaning anything.

9. **The audit log records `via: 'display-api'`** for every event a
   display-mode request causes. That is the only attribution the model can
   make without accounts, and `docs/design.md` says so.

10. **Both modes get the same Content-Security-Policy.** The pipeline runs
    in the family app, so display mode needs `'wasm-unsafe-eval'`, the R2
    upload origin, and `blob:`/`data:` images. `htmlHeaders` stops
    branching on mode.

11. **One implementation of every flow.** Trash with confirm, delete
    advances, undo by restore, edit and save, the single-flight refetch, and
    the patched-copy library live in one shared hook both apps use (section
    7.4). The admin passes its selection in; the family app passes none.
    Neither app has its own copy.

12. **In-flight tiles show their filename in both apps.** Before a
    thumbnail exists the filename is the only way to tell one queued file
    from another, and it is a file the person just chose from their own
    device. The pending listing's context has `filename: true`.

13. **The add bar's wording follows the existing 40rem breakpoint.** Narrow:
    "Add photos". Wide: "Drop photos here" with the hint "or press to
    choose them". One element, one input, one handler; only the text
    changes.

14. **The picker's accepted types are unchanged**, including `.heic` and
    `.heif`, pending validation item 1 (section 8). If a HEIC from an iPhone
    fails in mobile Safari, the family app narrows `accept` to JPEG and PNG
    on iOS only, by user agent, and the doc says an iPhone's HEIC arrives
    transcoded. That is the only browser sniff this spec permits, and only
    if the validation demands it.

15. **Firefox is re-measured, not assumed** (validation item 3). Pass:
    uploading is supported everywhere and decisions.md #20 is amended. Fail:
    when `navigator.userAgent` contains `Firefox`, the add bar shows a
    one-line note that adding photos works in Safari or Chrome, and still
    lets them try.

16. **No Trash undo across apps, no new notifications, no new email.** The
    daily digest counts family uploads as it counts any upload. The unseen
    marker on Recently added behaves as it does for the admin's own uploads.

## 5. What a family member sees

### 5.1 The page

The header holds the site title, the All photos / Recently added toggle,
and **Trash** with its count. Under the header sits the add bar. The timeline
is unchanged.

### 5.2 Adding

Tap the add bar on a phone, or drop files or press it on a laptop. Each file
appears at once as a tile above the timeline, with its filename, then its
date, then its picture, and under it the state word (Waiting, Processing,
Uploading, Finishing, Added, Already uploaded, Failed), exactly as in the
admin. Tapping a tile opens the lightbox with the edit form, so a date or a
caption can be typed while the phone is still encoding; a correction made
before the file commits is carried into the commit. When the batch has
landed and the library has reloaded, the landed tiles go; failures and
duplicates stay until cleared.

### 5.3 A photograph

Tapping a tile opens the lightbox. The bottom-left stack is the admin's:
capture date, capture time, and caption fields with **Save changes**, and an
action row of **Download**, **Delete**, and **Photo info**. No filename at
the top right. Photo info shows the original filename, the capture date, the
camera's UTC offset when there is one, and the full-size dimensions. It never
shows Emailed by, because the family context's `attribution` resolves to
`null` without a request.

Delete opens the preview-and-confirm dialog ("Delete photos?", "will move
to the trash, where they are kept for 30 days."). Enter confirms. After
confirming, the lightbox advances to the next photograph, or the previous at
the end, or closes if none remain, and a five-second Undo appears. Delete
and Backspace with focus outside the form do what the button does.

### 5.4 The trash

The Trash page is the grid, headed "Trash" with a count, and one line above
it:

> Deleted photos are kept for 30 days, then removed automatically. Tap a
> photo to look at it and restore it. Only the administrator can delete a
> photo permanently.

Tapping a trashed photograph opens the lightbox with **Restore** as its only
action: no Download, no Delete, no edit form. Restore puts the photograph
back, closes the lightbox, reloads the listing, and updates the header's
count. There is no selection, no bar, and no Delete permanently.

### 5.5 What is not there

No selection bar, no Select all on a day heading, no gesture line on a
listing, no caption box, no Emails, no Inbox, no Export catalog, no filename
on a library tile.

## 6. Server

### 6.1 The curation routes, in `netlify/functions/lib/curation-routes.ts` (new)

A module both Functions call, on the pattern of `read-routes.ts`. It moves
out of `admin.ts`, unchanged in behavior, the handlers for:

| Method | Path              | Handler today (in `admin.ts`) |
| ------ | ----------------- | ----------------------------- |
| GET    | `/trash`          | `listTrash`                   |
| GET    | `/trash/count`    | `trashCount`                  |
| POST   | `/begin-batch`    | `handleBeginBatch`            |
| POST   | `/prepare`        | `handlePrepare`               |
| POST   | `/commit`         | `handleCommit`                |
| POST   | `/edit`           | `handleEdit`                  |
| POST   | `/trash/preview`  | `handlePreview(…, 'trash')`   |
| POST   | `/trash/confirm`  | `handleTrashConfirm`          |
| POST   | `/restore`        | `handleRestore`               |

Its entry point:

```ts
export function curationRoute(
  request: Request,
  path: string,
  mode: AccessMode,
  store: () => S3ObjectStore,
): Promise<Response | null>;
```

`null` means "not a curation route, keep looking", exactly as `readRoute`
does. A 404 from inside it means "a curation route, and there is no such
photo".

`mode` exists for one reason: every audit event the module writes passes
`via: mode === 'admin' ? 'admin-api' : 'display-api'`. No handler relies on
`makeAuditEvent`'s default any more.

The preview/confirm token helpers (`handlePreview`'s minting and the
verification `handleTrashConfirm` and `handlePermanentDeleteConfirm` share)
move to `netlify/functions/lib/confirmation.ts` (new), imported by both this
module and `admin.ts`. The `kind` a token is bound to is unchanged: a trash
token still cannot confirm a permanent delete.

The module also exports the route list as data, for the test in 11.1:

```ts
export const CURATION_ROUTES: readonly { method: 'GET' | 'POST'; path: string }[];
```

### 6.2 `display.ts`

The `if (request.method !== 'GET') return notFound()` line goes. Dispatch
becomes: `checkAccess(request, 'display')`; then, for GET, `readRoute` and
`/download/<id>` as today; then `curationRoute(request, path, 'display',
store)`; then `notFound()`. Nothing admin-only is imported into this file.

`catch` keeps logging as "Display API failure".

### 6.3 `admin.ts`

Dispatch becomes: `checkAccess(request, 'admin')`; the admin-only GETs
(`/export`, `/emails`, `/inbox`, `/inbox/count`, `/inbox/part-url`,
`/download/<id>`, `/attribution/<id>`); `readRoute`; `curationRoute(request,
path, 'admin', store)`; then the admin-only POST switch (`/captions`,
`/permanent-delete/preview`, `/permanent-delete/confirm`, `/emails/*`,
`/inbox/*`); then `notFound()`.

Every handler that moved is deleted from this file, not copied.

### 6.4 The gate's CSP, in `netlify/edge-functions/gate.ts`

`htmlHeaders(mode)` passes `r2UploadOrigin: originOf(env('R2_S3_ENDPOINT'))`,
`allowWasm: true`, and `allowLocalImageSources: true` for both modes. The
`isAdmin` local and the comment "Only the admin app uploads…" go. The
`mode` parameter may stay for the call sites' sake or go; implementer's
discretion.

`contentSecurityPolicy` in `src/shared/headers.ts` does not change. Its
doc comments on `allowWasm` and `allowLocalImageSources` say "Admin only";
reword to say both apps.

### 6.5 Audit, in `src/shared/audit.ts`

`AuditEvent['via']` becomes
`'admin-api' | 'display-api' | 'scheduled-maintenance' | 'email'`. The
default in `makeAuditEvent` stays `'admin-api'` so that nothing else moves,
but no curation handler relies on it (6.1).

### 6.6 Fixture server, in `config/fixture-server.ts`

In `handle()`, the display base no longer refuses non-GET. Instead the
display branch dispatches to a new `handleCuration(route, method, body, url,
res)` that answers exactly the routes in `CURATION_ROUTES` (the fixture
server's own in-memory implementations, moved out of `handleAdmin`'s switch
and its GET block), then `handleDisplay` for GET, then 404. `handleAdmin`
answers its admin-only routes, then calls `handleCuration`, then falls
through to `handleDisplay` as it does today.

The display branch must not call `handleAdmin` for anything. A family-app
request for `/emails` under the display base is a 404 locally, as in
production. Section 11.1 tests this.

The fixture server's audit writes, if any, follow 6.1's `via` rule.

## 7. Client

### 7.1 Moves

Each of these moves with `git mv`, keeping its header comment, and every
import path is updated. Nothing is copied.

| From                                    | To                                      |
| --------------------------------------- | --------------------------------------- |
| `src/admin/components/Upload.tsx`       | `src/shared/ui/Upload.tsx`              |
| `src/admin/components/TrashPage.tsx`    | `src/shared/ui/TrashPage.tsx`           |
| `src/admin/components/Confirm.tsx`      | `src/shared/ui/Confirm.tsx`             |
| `src/admin/upload/queue.ts`             | `src/shared/ui/upload/queue.ts`         |
| `src/admin/upload/create.ts`            | `src/shared/ui/upload/create.ts`        |
| `src/admin/upload/pending.ts`           | `src/shared/ui/upload/pending.ts`       |
| `src/admin/advance.ts`                  | `src/shared/ui/advance.ts`              |

`src/shared/ui/` is the one place under `src/shared/` where DOM globals are
allowed, and the upload queue uses `File`, so `upload/` goes under `ui/`
and not beside `store.ts`. The pipeline stays at `src/pipeline/`; the
display build now imports it.

Stays in `src/admin/`: `selection.ts`, `deselect.ts`, `caption-apply.ts`,
`components/SelectionBar.tsx`, `components/CaptionApply.tsx`,
`components/ReplaceCaptions.tsx`, `components/EmailsPage.tsx`,
`components/InboxPage.tsx`, `inbox/`. `src/shared/ui/SelectAll.tsx` and
`SelectionHelp.tsx` stay where they are; they already render nothing
without `can.select`.

`create.ts` exports `uploadArtifact` and `createQueue` and nothing
Inbox-specific; `InboxPage.tsx` imports it and keeps doing so from its new
path, which is the allowed direction. The rule "nothing under `src/shared/`
imports from either app" must hold after the move; grep for it (section
11.4). `tsconfig.functions.json` and `tsconfig.worker.json` already exclude
`src/shared/ui/**`, so the moved browser code is not compiled for the
Functions or the Worker.

### 7.2 Capabilities, in `src/shared/ui/curation.ts`

```ts
export interface Capabilities {
  edit: boolean;
  download: boolean;
  trash: boolean;
  select: boolean;
  /** Restore from the trash. Only a trash listing says yes. */
  restore: boolean;
  /** The filename on a tile and at the lightbox's top right. Admin only,
      and the files still uploading. Photo info shows it regardless. */
  filename: boolean;
}
```

`Curation` gains one method:

```ts
/** Put a trashed photo back. Reachable only where `can.restore`. */
restore(id: string): void;
```

Required, like every other member. Contexts that never restore implement it
as the unreachable no-op `trash` already is in the trash's context.

The header comment on `Capabilities` ("Four of them rather than one
`readOnly` flag…") is rewritten for six, and the sentence "The viewer
provides no context at all" goes. The comment on `useCuration` ("`null` in
the viewer, which is how every shared component tells them apart") becomes:
`null` only in tests and in a listing that deliberately provides nothing;
both apps provide one, and components decide by `can`, never by presence.

The six contexts after this change:

| Listing               | edit | download | trash | select | restore | filename |
| --------------------- | ---- | -------- | ----- | ------ | ------- | -------- |
| Family library/recent | yes  | yes      | yes   | no     | no      | no       |
| Family uploading      | yes  | no       | no    | no     | no      | yes      |
| Family trash          | no   | no       | no    | no     | yes     | no       |
| Admin library/recent  | yes  | yes      | yes   | yes    | no      | yes      |
| Admin uploading       | yes  | no       | no    | no     | no      | yes      |
| Admin trash           | no   | no       | no    | yes    | yes     | yes      |

### 7.3 The curation API client, in `src/shared/ui/curation-api.ts` (new)

Moved verbatim from `src/admin/api.ts`: `ApiError`, the private `request`
and `post` helpers, the types `PrepareResult`, `CommitResult`,
`PreviewResult`, `TrashItem`, `TrashListing`, and an exported `curationApi`
with `trash`, `trashCount`, `beginBatch`, `prepare`, `commit`, `edit`,
`previewTrash`, `confirmTrash`, `restore`. It builds URLs through `routes`
from `./api.ts`, so it resolves to whichever base the build has.

`src/admin/api.ts` keeps `adminApi` with the admin-only methods (`emails`
and the recipient setters, `inbox` and the submission methods, `sendTest`,
`attribution`, `captions`, `previewPermanentDelete`,
`confirmPermanentDelete`, `exportUrl`), imports `request`/`post` from the
shared module (export them), and spreads `curationApi` into `adminApi` so
existing admin call sites keep working. Its header comment is updated.

### 7.4 The library hook, in `src/shared/ui/library.ts` (new)

Decision 11. Extracted from `src/admin/App.tsx`, behavior unchanged for the
admin. A hook:

```ts
export function useLibrary(options: {
  /** Order the delete-advance and the pruning measure in. */
  orderedIds: readonly string[];
  /** Which listing the reader is in, for the post-delete navigation. */
  onRecent: boolean;
}): Library;
```

It owns, moved from `App.tsx`:

- the fetched timeline, the patched copy, `data`, the `timeline` resource,
  and the single-flight `refetch`;
- `error` and `setError`;
- the trash count resource and `countTrashAgain`;
- `preview` state, `startTrash(query, from)`, `confirmTrash()`,
  `cancelTrash()`, including the advance-after-delete navigation and the
  undo offer a confirmed trash raises;
- `saveEdit(id, edit)`;
- `patchInPlace(photos)` and `setPatched`, since the admin's caption apply
  needs them;
- the undo offer, generalised: `offerUndo({ message, perform })`, where
  `perform` is `() => Promise<void>` and the hook keeps the serial, the
  once-only `undoing` guard, and the "withdraw only this offer" rule. The
  trash offer's `perform` calls `curationApi.restore`, then
  `countTrashAgain` and `refetch`, and surfaces a failure through `setError`.
  The admin builds its caption offer's `perform` from its existing
  `performUndo` caption branch.

It returns all of the above plus `dismissUndo` and `undo`. It calls
`curationApi` only.

A companion component in the same file or beside it renders what both apps
render below `main`: the error banner, the trash `Confirm` dialog (title
"Delete photos?", the existing description and label), and the
`UndoBanner` keyed by serial. Name it `LibraryChrome`; it takes the hook's
return value. The admin renders `ReplaceCaptions` next to it, not inside
it.

The `photoCount` helper and `targetOf` are shared by both Apps; move them to
`src/shared/ui/` (`targetOf` next to `TimelinePage`'s `TimelineTarget`
would be natural). Implementer's discretion where exactly.

### 7.5 The family App, `src/display/App.tsx`

Rewritten on the admin App's shape, minus selection and the extras.
`parseRoute(path, __APP_BASE__, ['trash'])`. The `Viewer` component goes;
`App` owns the library through `useLibrary`, builds the nav (view toggle
plus Trash with count), builds the `Curation` value:

```ts
{
  selectedIds: EMPTY,                 // a module-level empty ReadonlySet
  selectOnly: () => {}, toggle: () => {}, extendTo: () => {}, selectAll: () => {},
  trash: (id) => void startTrash({ kind: 'ids', photoIds: [id] }, id),
  edit: saveEdit,
  attribution: () => Promise.resolve(null),   // no request; display has no route
  restore: () => {},
  can: { edit: true, download: true, trash: true, select: false, restore: false, filename: false },
}
```

and renders, under the provider: the listing with `above={<UploadPanel …/>}`,
the photo page, and `LibraryChrome`. The `page` route renders `TrashPage`
with `bar={null}` (7.7). `not-found` renders `NotFound` under the Layout.

The comment "No `CurationContext` provider, so every shared component sees
`null`…" goes.

### 7.6 The admin App, `src/admin/App.tsx`

Uses `useLibrary` and `LibraryChrome`; keeps selection, the deselect
gestures, the selection bar, caption apply, the replace dialog, the inbox
count, and the four extra nav links. Its `Curation` value gains
`restore: () => {}` and `can: { …, restore: false, filename: true }`. The
render is otherwise what it is today. Its e2e tests must pass unchanged
(section 11.3): this is a refactor of the admin, not a change to it.

### 7.7 The Trash page, `src/shared/ui/TrashPage.tsx`

Props become:

```ts
{
  nav: ReactNode;
  onChanged: () => void;
  /**
   * The selection bar, or null. The admin passes its bar, which owns
   * Restore and Delete permanently for a selection; the family app passes
   * nothing, and restores from the lightbox.
   */
  bar: (state: TrashBarState) => ReactNode | null;
}
```

where `TrashBarState` gives the bar what it needs: `chosen: string[]`,
`busy: boolean`, `restore(ids): void`, `startPermanentDelete(ids): void`,
`deselectAll(): void`. The permanent-delete preview/confirm state, its
dialog, and `startPermanentDelete` stay in the page (the dialog is rendered
only when a preview exists, which only the admin's bar can cause, and
`adminApi.previewPermanentDelete` becomes an injected callback on the same
prop or a second prop; implementer's discretion, but the shared page must
not import `src/admin/api.ts`). The cleanest split: the page takes
`permanentDelete: { preview, confirm } | null`, and renders the dialog only
when non-null. Selection state moves out too: the page takes `selects:
boolean`; when false it holds no selection, provides `select: false`, and
does not install the deselect gestures (which live in `src/admin/`). When
true, the admin supplies the selection through the same mechanism it uses
for the library, and the page's context builds from it. If that threading
proves awkward, an acceptable alternative is for the admin to keep a thin
`AdminTrashPage` wrapper in `src/admin/` that owns the selection and
renders the shared page with the bar and the context's selection members
filled in. Either way there is one grid, one lightbox, one intro line
component, one restore call.

The page's context has `restore: (id) => void restore([id])` and `can.restore:
true`. The lightbox's Restore calls it; on success the page reloads as it
does after the bar's Restore, which also closes the lightbox (`reload()`
already sets `openId` to null).

The intro line is the one in 5.4 when `selects` is false and the existing
one when true.

### 7.8 The lightbox and the grid

Every branch on the context's presence becomes a capability check. The full
list, from `grep -n "curation" src/shared/ui/*.tsx`:

- `Lightbox.tsx` ~line 435, the top-right filename: `curation?.can.filename`.
- `Lightbox.tsx` ~line 138, the attribution fetch when Photo info opens:
  unchanged; the family context answers `null` without a request.
- `Lightbox.tsx` ~line 557, Download: unchanged (it already tests
  `can.download`).
- `Lightbox.tsx` ~line 562, Delete: unchanged. Add, after it and before
  Photo info, Restore: `curation?.can.restore ? <button type="button"
  onClick={() => curation.restore(photo.id)}>Restore</button> : null`.
- `Lightbox.tsx` ~line 295, Delete/Backspace keys: unchanged.
- `PhotoGrid.tsx` ~line 377, the tile filename: `curation?.can.filename`.
- `PhotoGrid.tsx` ~line 270, the `marks` data attributes: keyed off
  `selects`, not the context. The family's tiles carry no `data-selected`.
- `PhotoGrid.tsx` header comment ("Under a curation context the same tile
  also shows its original filename…"): rewritten for `can.filename`.
- `SelectAll.tsx`, `SelectionHelp.tsx`: unchanged; both already test
  `can.select`.

The Lightbox's header comment ("This is also the admin's editing view…")
is reworded: it is the editing view under any context with `edit`.

### 7.9 The add bar, in `src/shared/ui/Upload.tsx`

Decision 13. The headline and hint become width-dependent. Two `<p>`
elements are fine: `.drop-target__headline--wide` / `--narrow` hidden and
shown by the existing `@media (min-width: 40rem)` rule in the stylesheet,
so no JavaScript decides. Narrow headline: "Add photos". Narrow hint: "JPEG,
PNG, and HEIC." Wide headline and hint: as today. The `aria-label` stays
"Add photos: drop files here, or press to choose them".

Decision 15's note, only if Firefox fails: a third `<p
className="drop-target__note">` reading "Adding photos works best in Safari
or Chrome." rendered when `navigator.userAgent.includes('Firefox')`.
Absent otherwise. No other sniffing.

Decision 14's iOS narrowing, only if validation item 1 fails: the `accept`
attribute becomes `['.jpg', '.jpeg', '.png'].join(',')` when the user agent
matches iPhone or iPad; otherwise `ACCEPTED_EXTENSIONS`. `validate.ts` is
unchanged either way.

### 7.10 Styles

The rules for `.drop-target*`, `.trash__intro`, `.confirm*`, `.undo*`,
`.admin-banner`, `.admin-error`, `.admin-danger`, and the in-flight tile
states move from `src/shared/styles/admin.css` to a new
`src/shared/styles/curation.css`, imported by both `main.tsx` files after
`display.css`. `admin.css` keeps only what the admin alone renders: the
selection bar, selection marking, caption apply, the nav gap override, the
emails and inbox pages. The class names do not change; `admin-danger` and
`admin-error` are fine as names in a shared sheet, and renaming them is out
of scope.

The nav gap override in `admin.css` ("The admin's nav row is the crowded
one…") stays admin-only; the family's row is the toggle plus Trash and keeps
the shared spacing.

### 7.11 Vite

`vite.display.config.ts` gains `worker: { format: 'es' }` and
`optimizeDeps: { exclude: ['libheif-js'] }` from the admin config, with the
same comment, and `chunkSizeWarningLimit: 8000`. The comment "Nothing in
this build's module graph may reach src/admin" stays true and stays.

## 8. Validation items, run by the owner before section 7's UI work

These use `npm run dev:harness` (`vite.harness.config.ts`, `tests/e2e/harness/`)
on real devices, on the local network. Implement sections 6, 7.1 to 7.4,
and 7.11 first; they do not depend on the answers. Then stop and ask for the
results before 7.9 is finalised. Record the results in `docs/decisions.md`
(section 12.2).

1. **iPhone, mobile Safari, current accept list.** Pick a HEIC from the
   camera roll. Record: whether the file the page received was HEIC or
   JPEG (its `type` and first bytes); whether the capture date survived
   (the tile's date); whether a 12 MP and a 48 MP photograph each finish
   decode and encode without the tab reloading. Pass: both finish and the
   date survives. Fail: either reloads, or the date is lost. On fail, run
   item 2.
2. **iPhone, accept list narrowed to `.jpg,.jpeg,.png`.** Same photograph.
   iOS transcodes HEIC to JPEG in the picker when the page does not ask for
   HEIC. Record whether the capture date survives the transcode. Pass means
   decision 14's narrowing applies.
3. **Firefox on a Mac, five 12 MP files in a row.** Record seconds per file
   and whether the tab survives. Pass: all five complete. Decision 15
   applies either way.

The owner has noted that a HEIC has never survived any Apple export path
they have tried; item 1 is expected to hand over a JPEG.

## 9. What does not change

- The gate's routing, the two secret paths, `INTERNAL_GATE_SECRET`, and
  `checkAccess`. Nobody gets a new link.
- The Worker. It serves images and handles mail, and none of that moves.
- The read routes, the viewer projection (`PublicPhoto` still has no sender),
  and the `/download/<id>` signing.
- The pipeline. Decode and encode stay strictly serial; the queue moves but
  does not change.
- The catalog schema. No ownership field, no per-photo mode.
- The admin's behavior, gestures, and e2e tests.
- The daily digest, the unseen marker, the orphan sweep, the 30-day purge.

## 10. Traps

- **The fixture server is more permissive than production** and has hidden
  a missing route before (CLAUDE.md). After this change it must be exactly
  as permissive in both directions: the display base answers every
  curation route and refuses every admin-only one. Test both (11.1).
- **`checkAccess` runs before dispatch, and the mode check is the tier.**
  Do not add a second mode check inside a handler that "knows" it is
  admin-only; the dispatch order in 6.2 and 6.3 is the whole rule, and
  `curationRoute` must not be handed a mode it did not get from
  `checkAccess`.
- **The CSP is per mode in the gate, and the family app cannot upload
  without 6.4.** Locally the fixture server sets no CSP, so a build that
  forgot 6.4 works in development and fails in production with a console
  error and no upload. The headers test (11.1) is the guard.
- **`src/shared/` outside `ui/` and `styles/` must stay free of DOM
  globals.** The upload queue uses `File` and `Blob`; it goes under `ui/`.
  `npm run typecheck` runs the Worker and Functions tsconfigs over
  `src/shared/`, but `ui/` is excluded from those; confirm it still is
  after the move.
- **The viewer's context is no longer `null`.** A component that still
  branches on presence will show the family an admin control. Section 7.8
  lists every branch; grep again after the edit.
- **`marks` on a tile** sets `data-photo-id`, which the admin's deselect
  gestures and the e2e tests may read. Keying it off `selects` removes it
  from the family's tiles; check the admin e2e still finds it.
- **The moved `Upload.tsx` calls `onLibraryChanged` and awaits it.** The
  family App's `refetch` must be the hook's single-flight one, not a new
  fetch, or the in-flight tiles clear before the library holds them.
- **`parseRoute` refuses page names it was not given.** The family App
  must pass `['trash']` or `/trash` stays a 404 under the display base.
- **Every decode is serial, including the family's.** Two family members
  uploading at once are two browsers, each serial; that is fine. One
  browser with the add bar and an open lightbox decoding a preview is
  already handled by the module-global promise chain.
- **Delete and Backspace open the confirm dialog.** With `trash` on in the
  family's library, the lightbox's key handler reaches `curation.trash`.
  That is intended (5.3), and the form-focus rule (admin-merge spec,
  decision 6) still keeps a caret's Backspace out of it.

## 11. Tests

### 11.1 Unit

- **`tests/unit/curation-routes.test.ts` (new).** For every entry in
  `CURATION_ROUTES`, a display-mode request through `display.ts`'s default
  export does not return 404 for routing reasons. The practical assertion:
  with `INTERNAL_GATE_SECRET` set and the gate headers present, a request
  with an empty JSON body to each POST route returns a 400 (bad request),
  not a 404, and each GET route returns 200 against an in-memory store. To
  drive the real handler, both Functions export
  `createHandler(store: () => ObjectStore)` with the default export bound
  to S3. The test sets `INTERNAL_GATE_SECRET` and whatever else the
  handlers read from the environment (`.env.example` lists the names) in
  `beforeEach`.
- **The refusal direction, same file.** For each admin-only route (list
  them in the test; `/export`, `/attribution/<id>`, `/captions`,
  `/permanent-delete/preview`, `/permanent-delete/confirm`, `/emails`,
  `/emails/add`, `/inbox`, `/inbox/claim`, and the rest), a display-mode
  request returns the plain 404 with the same body and headers as an
  unknown path. Drive it against the in-memory store through the
  `createHandler` seam; the assertion is the response, nothing about the
  store.
- **`tests/unit/headers.test.ts`.** "gives the display app no route to R2
  at all" and "allows WebAssembly only in the admin app" are replaced by:
  both modes get the same policy; the display policy carries
  `'wasm-unsafe-eval'`, the R2 origin in `connect-src`, and `blob:` and
  `data:` in `img-src`. Test through whatever `gate.ts` exposes for
  `htmlHeaders`; if it exposes nothing, export it.
- **`tests/unit/audit.test.ts`.** `'display-api'` is an accepted `via`, and
  a `curationRoute` call in display mode writes it (through the route test
  above or a direct handler test).
- **Fixture server.** A test that the display base answers each
  `CURATION_ROUTES` entry and 404s each admin-only route, through
  `fixtureServer()`'s handler or a small exported dispatch function.
- **`tests/unit/routes.test.ts`.** `parseRoute` with `['trash']` yields the
  page for `/trash` and 404 for `/emails` and `/inbox`.

### 11.2 Component (`@vitest-environment happy-dom`)

- **Lightbox under the family library context:** the form and Save are
  present, Download and Delete and Photo info are present, no
  `.lightbox__filename`, no Restore.
- **Lightbox under the family trash context:** Restore only; no form, no
  Download, no Delete, no filename.
- **Lightbox under the admin library context:** unchanged, plus no Restore.
- **Lightbox under the admin trash context:** Restore present.
- **Photo info under the family context:** shows the filename; never
  requests attribution (spy on the context's `attribution`; it may be
  called and must resolve `null`, and the panel shows no Emailed by).
- **PhotoGrid under a context with `select: false, filename: false`:**
  no `.photo-grid__filename`, no `data-selected`, plain click navigates.
- **Delete key in the lightbox under the family library context** calls
  `curation.trash` (extend `lightbox-info.test.tsx` or the gestures test).
- **`useLibrary`:** the trash undo offer restores through the API and
  refetches; a second offer replaces the first; `undoing` prevents a double
  perform. Extract from any existing `App`-level coverage rather than
  writing new logic tests for the moved code.

### 11.3 End to end

`tests/e2e/display.spec.ts` gains a describe block, "the family can
curate", on chromium and webkit, with the sample-photos skip rule
`pipeline.spec.ts` uses:

- **Upload:** set files on `.drop-target__input` under the display base, wait
  for Added, and find the photograph on the timeline.
- **Edit:** open a photograph, change the caption, Save, reload the page,
  find the caption.
- **Trash and restore:** open a photograph, Delete, confirm with Enter,
  observe the lightbox advance, follow Trash in the nav, open the
  photograph, Restore, and find it back on the timeline with the Trash
  count decremented.
- **Refusal:** `page.request.get` on `<display base>/api/emails` and
  `page.request.post` on `<display base>/api/permanent-delete/preview`
  return 404.
- **No admin chrome:** no selection bar after a click, no Select all on a
  day heading, no `.photo-grid__filename`, no Emails or Inbox or Export
  link.

`tests/e2e/mobile.spec.ts` gains: the add bar reads "Add photos" at phone
width, and its input is reachable; the trash page fits the viewport.

`tests/e2e/admin.spec.ts`, `emails.spec.ts`, `inbox.spec.ts`, and
`recent.spec.ts` pass unchanged. If one needs a selector changed because a
component moved, that is fine; if one needs a behavior changed, the
refactor is wrong.

### 11.4 Static

- `grep -rn "from '../../admin\|from '../admin\|from '../../display\|from '../display" src/shared/` returns nothing.
- `grep -rn "src/admin" vite.display.config.ts` returns only the comment.
- `npm run check` passes, all three tsconfigs.
- `npm run build` succeeds and `dist/<display path>/assets/` contains the
  codec chunks, lazily referenced.

## 12. Documentation updates

Make these in the same change, and cite decision numbers from section 4 as
"family-tier.md #n".

### 12.1 `docs/design.md`

- **Goals:** "Provide a display-only site and an admin extension at a
  distinct URL path" becomes "Provide a family site, where anyone with the
  link can view and add photographs, and an admin extension at a distinct
  URL path."
- **Non-goals:** remove "Mobile administration beyond basic browser access;
  admin is laptop-oriented." Add "Per-person accounts or ownership of
  photographs; every family member acts with the same rights."
- **Access and privacy model:** the second bullet becomes: "The display
  path is the family link and can be shared among family members. Anyone
  holding it can view, add, edit, and trash photographs and restore them
  from the trash; the server enforces this by mode, not the page. The admin
  path is shared only with administrators and additionally allows permanent
  deletion, the Inbox, the Emails page, and the catalog export." Add a
  bullet: "The audit log records which link an act came through
  (`display-api` or `admin-api`) and nothing about who; there are no
  accounts, so it makes no person-level claim."
- **Technology:** the sentence about the admin app requiring Chromium or
  Safari becomes about *uploading*, in whichever app, and is amended per
  validation item 3.
- **Display site:** rename the section "Family site". Add, after the
  header bullet, the add bar, the in-flight tiles, the lightbox's edit form
  and Delete, the Trash link, and the trash page as 5.1 to 5.4 describe
  them. Say plainly what the family cannot do (5.5).
- **Admin site:** now "the family site with selection and four
  administrator-only surfaces added". Remove from it everything that moved
  to the family site's description, and keep: filenames on tiles and at the
  top right, the selection gestures and bar, caption apply, Emails,
  Submissions, Trash's Delete permanently, and Export. The last bullet
  ("Admin workflows are explicitly laptop-oriented…") goes.
- **Trash:** add "A family member restores from the lightbox; an
  administrator can also restore or permanently delete a selection."
- **Implementation validation:** add the three items from section 8 with
  their results once known.

### 12.2 `docs/decisions.md`

Add entry 90, "The display link is the family link", with the reasons in
section 1 and the rejected alternatives in decision 1, and the CSP finding
(the display policy blocked WebAssembly and R2, and had to be unified).
Amend #20 with validation item 3's result, either way. Record items 1 and
2's results with the entry.

### 12.3 `docs/implementation-plan.md`

Line ~81's "display.ts read-only catalog/photo API" and the "Display API"
section (~line 315) say display mode answers reads, downloads, and the
curation routes, and name `lib/curation-routes.ts` beside
`lib/read-routes.ts`.

### 12.4 `CLAUDE.md`

- Architecture, "The gate is the whole access model": add one sentence after
  the first paragraph: "Display mode may mutate: it reaches the curation
  routes in `netlify/functions/lib/curation-routes.ts` and nothing
  admin-only. The route lists in that module and in `admin.ts` are the
  tier; a test asserts them."
- The runtime table: the Viewer app row's entry becomes
  `src/display/ + src/pipeline/ + src/shared/ui/`, and its "Reaches R2 via"
  becomes "presigned S3 PUTs".
- "The two apps are separate builds": the sentence "the viewer provides
  `null`" becomes "both apps provide one, and components decide by
  `Curation.can`, never by presence". The "three listings" sentence
  becomes six, or is dropped in favor of pointing at the table in
  `curation.ts`.
- Invariants: add "**Display mode is a tier, not a read-only mode.** The
  display Function answers the curation routes; the fixture server's display
  branch must answer exactly the same list, and both must refuse every
  admin-only route with the plain 404."
- Testing: mention `curation-routes.test.ts` as the whitelist test.

### 12.5 `docs/operations.md`

In the Launch checklist (the last section), one paragraph: the family link
now allows adding, editing, and trashing photographs and
restoring from the trash; tell the family when it goes live; anything
trashed by mistake can be restored from Trash by anyone with the link for 30
days; permanent deletion still needs the admin link. No secret values.

### 12.6 Code comments that go stale

- `netlify/functions/display.ts` header ("The read-only display API").
- `src/shared/ui/api.ts` header ("the viewer has no writes at all").
- `src/shared/ui/curation.ts` (7.2).
- `src/shared/ui/PhotoGrid.tsx` and `Lightbox.tsx` headers (7.8).
- `src/display/App.tsx` (7.5).
- `netlify/edge-functions/gate.ts`, the comment on `htmlHeaders`.
- `src/shared/headers.ts`, the "Admin only" comments on `CspOptions`.
- `src/shared/styles/admin.css`, the nav-gap comment listing "three extra
  links" (it is four: Trash is shared now, so Emails, Inbox, Export).
- `src/admin/App.tsx` header ("Everything that makes it an admin is the
  `CurationContext` this provides") is no longer true; the admin is the
  family app plus selection and four pages.

## 13. Deploying

Netlify only, on push to `master`. The Worker is untouched; do not run
`wrangler deploy`. Before pushing, `npm run check`, `npm run test:e2e`, and
`npm run build`. There is no data migration and no env var change:
`R2_S3_ENDPOINT` is already read by the gate for the admin CSP.

Do not push or deploy without the owner's say-so (their standing rule).

## 14. Out of scope

- A Select switch or any bulk action in the family app (decision 5).
- Per-person identity, ownership, or attribution of any kind.
- Emptying the trash, permanent deletion, the Inbox, Emails, or export from
  the family link.
- Renaming `display` to `family` in code, env vars, or the gate.
- Changing the pipeline, its concurrency, or its accepted types beyond
  decision 14's conditional narrowing.
- A phone-specific upload flow beyond the add bar's wording. If the
  validation items pass, the existing pipeline is the phone's pipeline.
- Restyling the admin.

## 15. Implementer's discretion

- The exact split of `useLibrary` and `LibraryChrome`, and where `targetOf`
  and `photoCount` land, so long as decision 11 holds: one implementation,
  used by both apps.
- Whether `TrashPage` takes the admin's selection through props or the
  admin wraps it (7.7), so long as there is one grid, one lightbox, and one
  restore call.
- Whether `htmlHeaders` keeps its `mode` parameter.
- Whether the confirmation helpers (6.1) get their own module or join
  `http.ts`. A separate module is preferred.
- The `createHandler` seam in 11.1, if the tests can be written without it.
- The exact wording of the trash intro line, so long as it says tap to
  look and restore, and that only the administrator deletes permanently.
- Where in `docs/operations.md` the paragraph in 12.5 goes.
