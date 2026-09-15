# The family trashes only what it added

Spec, 2026-09-14. A follow-up to `docs/specs/family-tier.md`, written after a
design interview; the decisions below are settled unless marked
"implementer's discretion". A separate agent implements this, without the
interview's context. Where this spec and `family-tier.md` disagree, this spec
wins, and section 11 amends that spec's text. Where it and the code disagree,
the spec wins.

Amended 2026-09-15 by section 15: the family also deletes permanently, from
its trash, what it added from the same browser. Where section 15 and an earlier
section disagree, section 15 wins.

## 1. Outcome

A family member can move a photograph to the trash only if it was added from
the browser they are using. Everything else about the family link stays as
`family-tier.md` built it: anyone can add photographs, and anyone can
correct any photograph's date, time, or caption.

The reason is the accidental upload. Someone adds a photograph, immediately
realises it should not be on the family site, and wants it gone without
asking the administrator. The family-tier release let anyone trash anything,
and the owner does not want a family member able to trash photographs at
random.

"Added from this browser" is decided by a random token the family app keeps
in local storage. Each commit from the family link records a hash of it on
the photograph. The server allows a family trash or restore only when the
request's token hashes to the photograph's recorded hash. No account, no
person, no email address, no IP address, and no browser fingerprint are
involved.

What this deliberately gives up:

- A photograph added from a phone cannot be trashed from the same person's
  laptop, or from a replacement phone. Only the administrator can trash it.
- Every photograph that did not come through the family link has no hash:
  everything already in the library, everything the administrator uploads,
  and everything accepted from the Inbox. The family can never trash those.
- If a browser clears its storage, including iOS evicting storage for a site
  not visited for weeks, that browser gets a new token and loses the ability
  to trash its earlier uploads. Nothing can detect this at upload time.

Release: this ships together with the family-tier work, which was rolled
back from production for this reason. Master was reset to `4c55001` plus the
libheif upgrade; the family-tier commits are on the branch
`family-tier-deployed`, and this spec is committed there. Implement on that
branch's code. The owner decides when master moves back to it. Do not push
and do not deploy.

## 2. Where things stand on `family-tier-deployed`

- `netlify/functions/lib/curation-routes.ts` answers the curation routes for
  both Functions. `curationRoute(request, path, mode, store)` hands each
  handler `{ request, store, via }`. Today no handler knows the mode except
  as `via` for the audit log. Handlers: `listTrash`, `trashCount`,
  `handleBeginBatch`, `handlePrepare`, `handleCommit`, `handleEdit`,
  `handleTrashPreview`, `handleTrashConfirm`, `handleRestore`.
- `handleTrashPreview` accepts any `SelectionQuery`, including a whole day,
  month, or year. In display mode that is reachable by hand today, though the
  family app only ever sends `{ kind: 'ids' }` with one ID.
- `netlify/functions/lib/confirmation.ts`: `issueConfirmation(action, ids)`
  and `readConfirmation(request, action)`. The token is an HMAC over the
  action, the ID list, and the expiry.
- `src/shared/catalog.ts`, `PhotoRecord`: `submittedBy?: string | null` is the
  precedent for an optional field added without bumping
  `CATALOG_SCHEMA_VERSION`. Its doc comment explains why. Every mutation
  spreads the record, so a rollback would not strip a new field.
- `src/shared/admin-operations.ts`: `commitPhoto(catalog, CommitInput, …)`,
  `trashPhotos(catalog, ids, …)`, `restorePhotos(catalog, ids, …)`.
  `CommitInput` carries `submittedBy`, resolved server-side.
- `src/shared/ids.ts` has `randomBytes` and a private `toHex`, working in
  browsers, Node, and Workers. `src/shared/signing.ts` reaches
  `crypto.subtle` the same runtime-neutral way. `netlify/lib/routing.ts`
  exports `secureEquals`.
- The gate sets `x-photo-access-mode` and `x-photo-gate-secret` on API
  requests and passes every other request header through unchanged.
- `src/shared/ui/curation-api.ts`: `request()` and `post()` send every
  curation call; `curationApi.commit` returns `{ status, photo? }`.
- `src/shared/ui/upload/create.ts`: `createQueue()` wires the queue to
  `curationApi`. `UploadPanel` in `src/shared/ui/Upload.tsx` calls it with no
  overrides, in both apps. The admin's Inbox calls it with a `commit`
  override.
- `src/shared/ui/curation.ts`: `Capabilities.trash` is a boolean per listing.
  The Lightbox shows Delete, and handles the Delete and Backspace keys, where
  `curation?.can.trash` is true (`Lightbox.tsx`, about lines 298 and 567).
  Photo info (about line 499) lists original filename, Emailed by in the
  admin, capture date, UTC offset, and dimensions.
- `src/shared/ui/library.ts`, `useLibrary`: the trash count, the trash
  preview and confirm, and the undo that calls `curationApi.restore`.
- `src/shared/ui/TrashPage.tsx`: lists `curationApi.trash()`; its context
  has `can.restore: true`.
- `src/display/App.tsx`: the family library context has `trash: true`, and
  the nav always shows `Trash (n)`.
- `src/shared/ui/unseen.ts` is the pattern for local storage that may throw:
  every read and write wrapped, with a sensible answer when it fails.
- `config/fixture-server.ts`: `handleCuration(route, method, body, res)` is
  called from the display branch and from `handleAdmin`, with no mode.
- `fixtures/catalog.ts`: each Playwright project has its own scratch day,
  whose fourth photo (`deleted-<day>`) is trashed, "so each project has
  something in the trash to restore that no other project touches".
- `tests/unit/curation-routes.test.ts` drives both real Functions through
  `createHandler` over an in-memory store, with a `gated()` request helper.
- `tests/e2e/display.spec.ts`, "the family can curate", trashes a fixture
  photograph and restores it, expecting `Trash (2)` then `Trash (3)`.

## 3. Vocabulary

- **Uploader token**: 32 random bytes, lowercase hex, 64 characters,
  generated by the family app and kept in its browser.
- **Uploader hash**: SHA-256 of the token's ASCII string, lowercase hex. The
  only form the server stores.
- **Added here**: a photograph whose ID this browser has recorded as
  committed by it (section 6.2). The client's notion, used to decide what to
  show.
- **Owned**: a photograph whose stored uploader hash equals the request's
  uploader hash. The server's notion, and the only one that grants anything.

## 4. Decisions

Numbered so the implementation and the docs can cite them.

1. **Ownership is a browser token, not an IP address or a fingerprint.** A
   household shares one IP address and a phone changes it every time it
   leaves the house. Two iPhones of the same model on the same iOS version
   have the same fingerprint. A random token identifies a browser, stores
   nothing about a person, and the catalog holds only its hash.

2. **Ownership never expires.** A photograph stays trashable from its
   browser for as long as that browser keeps its storage. Rejected: a time
   window, and tying it to the Recently added set.

3. **Only photographs committed through the family link carry a hash.** The
   admin Function never records one, even if a token header arrives. Existing
   photographs, admin uploads, and Inbox acceptances stay admin-only to
   trash. There is nothing to backfill from.

4. **Delete appears only on photographs added here.** No disabled button
   and no explanation on other photographs. Photo info on a photograph added
   here gains one line saying so (section 7.3), which is how a family member
   on another device can work out why Delete is missing.

5. **The browser remembers the IDs it committed.** It does not ask the
   server which photographs it owns, and the timeline projection gains
   nothing. The ID list and the token live in the same storage and are lost
   together. Rejected: putting the uploader hash in the viewer projection,
   which would let any viewer group photographs by device, and an `own` flag
   computed per request, which makes every read vary by header.

6. **The family's trash lists only owned photographs**, and restore is
   limited to them. Other trashed photographs are invisible to the family,
   not merely unrestorable.

7. **Editing is unchanged.** Anyone with the family link can edit any
   photograph's date, time, and caption.

8. **An owned photograph the administrator trashed appears in its owner's
   trash, and they can restore it.** No trashed-by record. A disagreement
   about such a photograph is a family conversation.

9. **When storage is unavailable, upload anyway, keep the token in memory,
   and say so.** The token and the ID list live for the life of the page, so
   a mistake noticed right away can still be deleted. The add bar shows one
   line explaining that deleting stops working when the page closes. Silent
   storage eviction cannot be detected and gets no message.

10. **The family's Trash link appears only when their trash has something in
    it.** It appears after their first delete and disappears when the count
    returns to zero. `/trash` itself stays reachable.

11. **No cross-device ownership.** A new or second device is a different
    uploader. Rejected: a link carrying the token, which puts a deletion
    secret in something the family forwards, and a code to type.

12. **The server is the authority; the client only decides what to show.**
    A family trash or restore of a photograph the request does not own is
    the same plain 404 as an unknown photograph, whatever the page showed.

13. **Display mode may trash only by explicit ID.** Its trash preview
    refuses any other selection kind with a 404. The family app has no
    selection, and a day or month query would otherwise need its own
    ownership rule.

14. **The admin link is unchanged.** It trashes, restores, and lists
    everything, as today.

## 5. What a family member sees

- **On a photograph they added from this browser**, the action row is
  Download, Delete, Photo info, and Photo info includes "Added from: This
  device". Delete behaves exactly as `family-tier.md` 5.3 describes: confirm,
  advance, five-second Undo.
- **On any other photograph**, the action row is Download and Photo info.
  Delete and Backspace do nothing.
- **In the header**, Trash with its count appears only while their trash is
  non-empty.
- **On the Trash page**, the intro line reads:

  > Photos added from this device that have been deleted are kept here for
  > 30 days, then removed automatically. Tap one to look at it and restore
  > it.

  The page lists only their photographs. Opening one offers Restore, as
  today.
- **When storage is unavailable**, the add bar shows, under its hint, at every
  width:

  > This browser can't remember your uploads after you close this page, so
  > you won't be able to delete them after that.

## 6. Mechanics

### 6.1 Shared rules, in `src/shared/uploader.ts` (new)

Runtime-neutral, compiled by all three tsconfigs; no DOM, Node, or Workers
globals beyond Web Crypto reached the way `signing.ts` reaches it.

```ts
/** The request header a family browser sends its token in. */
export const UPLOADER_HEADER = 'x-photo-uploader';

/** 64 lowercase hex characters. */
export function isUploaderToken(value: unknown): value is string;

/** SHA-256 of the token's characters, lowercase hex. */
export async function hashUploaderToken(token: string): Promise<string>;

/** True only when the photo carries a hash and it equals `hash`. */
export function isOwnedBy(photo: PhotoRecord, hash: string | null): boolean;
```

`isOwnedBy` returns false when `hash` is null or the photo has no
`uploaderHash`. It compares with a constant-time comparison. `secureEquals`
lives in `netlify/lib/routing.ts`, which `src/shared/` must not import, so
move it to `src/shared/` (for example into this module or `signing.ts`) and
re-export it from `routing.ts` so the gate's import does not change.

`src/shared/ids.ts` gains `generateUploaderToken(): string`, 32 random bytes
as hex, beside the other generators.

### 6.2 The browser, in `src/shared/ui/uploader.ts` (new)

DOM-side, so under `ui/`.

```ts
export interface Uploader {
  readonly token: string;
  /** False when local storage refused the token; everything lives in memory. */
  readonly persistent: boolean;
  /** This browser committed a photograph with this ID. */
  addedHere(photoId: string): boolean;
  remember(photoId: string): void;
}

/** One per page, created on first call. */
export function getUploader(): Uploader;
```

Two local-storage keys: `photo-uploader-token` and `photo-uploaded-ids`, a
JSON array of photo IDs. On first call:

1. Read the token. If it is missing or fails `isUploaderToken`, generate one
   and write it.
2. Read it back. If the read-back differs, or any read or write threw, the
   uploader is not persistent: keep the generated token in memory and hold
   the IDs in memory from then on.
3. Read the ID list. A missing or unparseable value is an empty list.
   Discard entries that fail `isValidPhotoId`.

`remember` adds to the in-memory set and, when persistent, writes the list,
swallowing a write failure. The list is never pruned: a few hundred photo IDs
a year is a few kilobytes.

The admin and family apps share one origin, so the admin app must never call
`getUploader()`. Only the family entry point does (6.3).

### 6.3 Sending the token, in `src/shared/ui/curation-api.ts`

A module-level `let uploader: Uploader | null = null` and:

```ts
/** Called once by the family app's entry point. The admin never calls it. */
export function configureUploader(value: Uploader): void;
```

When configured, `request()` adds `[UPLOADER_HEADER]: uploader.token` to
every curation request, and `curationApi.commit` calls
`uploader.remember(result.photo.id)` when the result is `created`. A
`duplicate` result remembers nothing, because the existing photograph is not
this browser's.

`src/display/main.tsx` calls `configureUploader(getUploader())` before
rendering. `src/admin/main.tsx` does not change. The upload queue, the upload
panel, and the Inbox's commit override need no change for the token to flow,
because they all commit through `curationApi.commit`.

### 6.4 The record, in `src/shared/catalog.ts` and `admin-operations.ts`

`PhotoRecord` gains:

```ts
/**
 * SHA-256 of the family browser token that committed this photograph, or
 * null. Only a commit through the family link records one
 * (family-own-trash.md #3). Never in the viewer projection.
 */
uploaderHash?: string | null;
```

Its doc comment follows `submittedBy`'s: optional on read, always written,
and `CATALOG_SCHEMA_VERSION` stays 1, for the same reasons. `CommitInput`
gains `uploaderHash?: string | null`, and `commitPhoto` writes
`uploaderHash: input.uploaderHash ?? null`.

`toPublicPhoto` does not change, and a unit test asserts it never carries
`uploaderHash` (11.1). The admin's catalog export includes it, which is fine.
It is a hash of a random value, not a person. The audit log does not record
it.

### 6.5 The server, in `netlify/functions/lib/curation-routes.ts`

`CurationRequest` gains `mode: AccessMode` alongside `via`. A helper:

```ts
/** The request's uploader hash in display mode; null in admin mode or when absent or malformed. */
async function uploaderHashOf(context: CurationRequest): Promise<string | null>;
```

Admin mode behaves exactly as today in every handler below. In display mode:

| Route                 | Display-mode rule                                                                                                                                                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /commit`        | No valid token: 400, "An uploader token is required." Otherwise the commit records `uploaderHash`. |
| `POST /trash/preview` | No valid token: 404. Selection not `{ kind: 'ids' }`: 404. Resolve, keep only owned IDs; if none remain, 404. Otherwise `issueConfirmation('trash', ownedIds)`.                                                                    |
| `POST /trash/confirm` | No valid token: 404. After `readConfirmation`, inside the `mutateCatalog` callback, filter the confirmed IDs to those still owned before calling `trashPhotos`. The confirmation token already binds the list; this is the write's own check.     |
| `POST /restore`       | No valid token: 404. Filter `photoIds` to owned photographs; if the request named any and none remain, 404. Otherwise `restorePhotos` with the filtered list.                                                                       |
| `GET /trash`          | No valid token: an empty listing. Otherwise only owned trashed photographs.                                                                                                                                                         |
| `GET /trash/count`    | No valid token: `{ count: 0 }`. Otherwise the owned trashed count.                                                                                                                                                                  |
| All others            | Unchanged.                                                                                                                                                                                                                         |

The listing and the count answer empty rather than 404 without a token,
because the family app asks for the count on every page load.

The filtering for the restore and the confirm happens against the catalog
inside the mutation callback, so a retry after a conflicting write re-checks
against the reloaded catalog.

The module's header comment gains a paragraph stating the display-mode
ownership rule and citing this spec.

### 6.6 Fixture server, in `config/fixture-server.ts`

`handleCuration` gains `mode: 'display' | 'admin'` and
`uploaderToken: string | null`, read from the request's `x-photo-uploader`
header by `handle()`. It applies section 6.5's rules through the same
`src/shared/uploader.ts` helpers, so local development is no more permissive
than production. The display branch passes `'display'`; `handleAdmin`
passes `'admin'`.

### 6.7 Fixtures, in `fixtures/catalog.ts`

A spec field `uploaderHash?: string`, carried into the record. Export
`FIXTURE_UPLOADER_TOKEN`, a fixed 64-character hex string, and compute its
hash in the fixture module. Give each project's scratch-day photographs the
fixture token's hash: the three live ones and the trashed `deleted-<day>`.
Every other fixture photograph has none. Library counts do not change, and
the admin's trash still lists everything.

## 7. Client

### 7.1 `Capabilities.trash` becomes three-valued, in `src/shared/ui/curation.ts`

```ts
/**
 * Which photographs the photo view offers Delete for: every one, only those
 * added here (the family's library), or none.
 */
trash: 'all' | 'own' | 'none';
```

`Curation` gains a required member:

```ts
/** This browser added the photograph. Only the family's library can say yes. */
addedHere(id: string): boolean;
```

The table in the `Capabilities` comment becomes:

| Listing               | edit | download | trash  | select | restore | filename |
| --------------------- | ---- | -------- | ------ | ------ | ------- | -------- |
| Family library/recent | yes  | yes      | `own`  | no     | no      | no       |
| Family uploading      | yes  | no       | `none` | no     | no      | yes      |
| Family trash          | no   | no       | `none` | no     | yes     | no       |
| Admin library/recent  | yes  | yes      | `all`  | yes    | no      | yes      |
| Admin uploading       | yes  | no       | `none` | no     | no      | yes      |
| Admin trash           | no   | no       | `none` | yes    | yes     | yes      |

Every context other than the family library implements `addedHere` as
`() => false`. The family library's is `(id) => getUploader().addedHere(id)`.
A shared helper, for example `canTrash(curation, photoId)`, returns true for
`'all'`, and for `'own'` returns `curation.addedHere(photoId)`. Both Lightbox
call sites use it.

### 7.2 The family App, `src/display/App.tsx`

- The library context: `trash: 'own'`, `addedHere` as in 7.1.
- The nav: the Trash link renders only when `trashCount` is a number greater
  than zero.
- The upload panel receives the storage note (7.4) when
  `getUploader().persistent` is false.

### 7.3 The Lightbox, `src/shared/ui/Lightbox.tsx`

- The Delete button and the Delete and Backspace key handler use
  `canTrash(curation, photo.id)` in place of `curation?.can.trash`.
- In Photo info, directly after Original filename, when
  `curation?.addedHere(photo.id)`:

  ```tsx
  <dt>Added from</dt>
  <dd>This device</dd>
  ```

### 7.4 The add bar, `src/shared/ui/Upload.tsx`

`UploadPanelProps` gains `note: string | null`. When non-null it renders as
`<p className="drop-target__note">` after the hints, at every width. The
family App passes the sentence in section 5 when storage is unavailable;
otherwise both apps pass `null`. Style `.drop-target__note` in
`src/shared/styles/curation.css` like the hint. Implementer's discretion on
exact styling.

### 7.5 The Trash page, `src/shared/ui/TrashPage.tsx`

The family intro line changes to section 5's text. The listing and restore
calls do not change; the server filters. Its context gains
`addedHere: () => false` and `trash: 'none'`.

### 7.6 The admin, `src/admin/App.tsx`

Its library context becomes `trash: 'all'` with `addedHere: () => false`.
Nothing else changes, and the admin's e2e tests pass unchanged.

## 8. What does not change

- The gate, the access modes, the two paths, and every admin route.
- Editing, downloading, and uploading from the family link, apart from the
  token header.
- The viewer projection: `PublicPhoto` gains nothing.
- The pipeline, the upload queue, and the Inbox.
- The Worker, the purge, the orphan sweep, and the digest.
- The catalog schema version.

## 9. Traps

- **One origin, two apps.** Local storage is shared between the admin and
  family paths. If the admin app ever called `getUploader()`, it would record
  admin uploads as added here, and the family link in that browser would show
  Delete on photographs the server refuses. Only `src/display/main.tsx`
  configures it.
- **The client decides nothing.** A test that passes because Delete is hidden
  proves nothing about the tier. The server tests in 11.1 are the ones that
  matter.
- **The count is per browser now.** The family e2e test's `Trash (2)`
  expectation assumed a global count. Rewrite it around the fixture token
  (11.3), and make sure no other family test reads the Trash link's text.
- **Preview in display mode used to accept day and month queries.** Close
  that (decision 13) and test it, or a hand-made request trashes a whole day
  of owned and unowned photographs.
- **A retry must re-check ownership.** `mutateCatalog` reloads and re-runs
  the callback on a conflict, so filter inside the callback, not before it.
- **`secureEquals` moves.** The gate imports it from `routing.ts`; keep that
  import working with a re-export, and keep `routing.ts` out of
  `netlify/edge-functions/` (CLAUDE.md).
- **`src/shared/uploader.ts` is compiled for the Worker.** Keep it free of
  DOM and Node globals, and run all three typechecks.
- **An iPhone that clears storage** gets a new token silently. That is
  accepted (section 1); do not add detection.

## 10. Deploying

None from you. Commit on the `family-tier-deployed` branch. The owner moves
master and deploys Netlify. The Worker is untouched.

## 11. Tests

### 11.1 Unit

- **`tests/unit/uploader.test.ts` (new).** `isUploaderToken` accepts 64 hex
  characters and rejects anything else. `hashUploaderToken` of a known token
  matches a precomputed SHA-256. `isOwnedBy` is false for a null hash, for a
  photograph without `uploaderHash`, and for a different hash, and true for
  the same hash.
- **`tests/unit/uploader-storage.test.ts` (new, `@vitest-environment
  happy-dom`).** A first call generates and persists a token, and a second
  page load, simulated by resetting the module, reads the same token. When
  `localStorage.setItem` throws, `persistent` is false, and `remember` then
  `addedHere` still works for that page. An unparseable ID list is treated as
  empty.
- **`tests/unit/curation-routes.test.ts`.** In display mode, over the
  in-memory store:
  - A commit without a token returns 400. A commit with one records its hash
    on the record, and the audit event does not contain it.
  - A commit in admin mode with a token header records no hash.
  - A trash preview of a photograph with a different hash, with no hash, or
    without a token returns the plain 404, the same body and headers as an
    unknown path.
  - A trash preview with a `day` selection returns 404 even when every
    photograph that day is owned.
  - A trash preview and confirm of an owned photograph trashes it.
  - A confirm whose photograph stopped being owned between preview and
    confirm trashes nothing. Construct it by rewriting the record's hash in
    the store between the two calls.
  - Restore of an unowned trashed photograph returns 404. Restore of an
    owned one succeeds, including one trashed through the admin link.
  - The trash listing and count include only owned photographs, and are empty
    without a token.
  - In admin mode, every one of the above behaves as today.
- **`tests/unit/display-api.test.ts`.** `toPublicPhoto` of a record with
  `uploaderHash` has no such key.
- **`tests/unit/fixture-server.test.ts`.** The display branch refuses an
  unowned trash preview and filters the trash listing, the same as the real
  Function.

### 11.2 Component (`@vitest-environment happy-dom`)

- Under a context with `trash: 'own'`: Delete and the Delete key act on a
  photograph whose `addedHere` is true, and are absent or inert on one whose
  `addedHere` is false. Photo info shows "Added from / This device" only on
  the first.
- Under `trash: 'all'`: Delete is present regardless of `addedHere`, and
  Photo info shows no "Added from" line.
- `UploadPanel` with a `note` renders it; with `null`, it renders no
  `.drop-target__note`.

### 11.3 End to end

In `tests/e2e/display.spec.ts`, "the family can curate":

- Before each test, `page.addInitScript` writes `FIXTURE_UPLOADER_TOKEN` to
  `photo-uploader-token` and the project's scratch-day photo IDs to
  `photo-uploaded-ids`.
- **Replace** the trash-and-restore test: open a live scratch-day photograph;
  Delete is present; confirm; the Trash link appears with the count of owned
  trashed photos; on the Trash page only scratch-day photographs are listed;
  Restore puts it back.
- **Add:** open a fixture photograph outside the scratch day. Photo info has
  no "Added from" line, and there is no Delete button.
- **Add:** without the init script, a fresh browser shows no Trash link, and
  `page.request.post` of a trash preview for a scratch-day photo with no
  uploader header returns 404.
- **Upload test (sample-photos gated):** after the upload lands, the new
  photograph has Delete and "Added from / This device".

The admin e2e specs pass unchanged.

## 12. Documentation updates

Make these in the same change.

### 12.1 `docs/specs/family-tier.md`

Under the status paragraph at the top, add: "Decisions 3 and 6, the trash in
sections 5.3 and 5.4, and the Trash link in 5.1 are amended by
`family-own-trash.md`: the family trashes, restores, and sees in the trash
only photographs added from the same browser." Do not rewrite the body.

### 12.2 `docs/design.md`

- **Access and privacy model**, the family link bullet: "can view, add,
  edit, and trash photographs" becomes "can view, add, and edit
  photographs, and trash and restore the ones added from the same browser".
  Add a bullet describing the uploader token: a random value kept in the
  browser, only its hash stored on a photograph, never shown to viewers,
  identifying a browser rather than a person.
- **Family site**: the Trash link bullet, the photo view bullet, and the
  Trash page bullet follow section 5. Add the storage note to the add bar
  bullet.
- **Non-goals**: add "Cross-device ownership of uploads."
- **Trash**: add that the family's trash lists only its own browser's
  photographs.

### 12.3 `docs/decisions.md`

Add entry 92, "The family trashes only what it added from the same
browser", covering the accidental-upload reason, decision 1's rejected
proxies, decision 5's rejected alternatives, decision 8's accepted
consequence, and that this shipped together with #90 after #90 was rolled
back from production. Amend #90 with a pointer to #92.

### 12.4 `CLAUDE.md`

- Under "The gate is the whole access model", after the paragraph on display
  mode, add: "In display mode a trash or restore reaches only photographs
  whose `uploaderHash` matches the request's `x-photo-uploader` token
  (`src/shared/uploader.ts`); anything else is the plain 404."
- Invariants: add "**Only the family entry point configures the uploader
  token.** Both apps share an origin and so share local storage; an admin
  that recorded its uploads there would show the family Delete on
  photographs the server refuses."

### 12.5 Code comments that go stale

- `src/shared/ui/curation.ts`, the `Capabilities` comment and table.
- `src/display/App.tsx`, the header comment's "move any photograph to the
  trash, and restore from the trash".
- `netlify/functions/lib/curation-routes.ts`, the header (6.5).
- `src/shared/ui/library.ts`, the header's "since the family link can delete".
- `src/shared/ui/TrashPage.tsx`, the header's family sentence.

## 13. Out of scope

- Any expiry or time window on ownership.
- Cross-device ownership, token export, or recovery.
- Recording who trashed a photograph.
- Narrowing who may edit.
- Detecting storage eviction.
- Any change to the admin link.

## 14. Implementer's discretion

- Where `secureEquals` lands under `src/shared/`, so long as the gate's
  import still resolves.
- The name and location of the `canTrash` helper.
- Whether `uploaderHashOf` caches its hash per request.
- The styling of `.drop-target__note`.
- How the e2e init script learns the scratch-day IDs, for example by
  importing `FIXTURE_PHOTO_IDS` as the existing tests do.

## 15. Amendment, 2026-09-15: the family deletes its own photographs permanently

The owner decided that a family member should be able to permanently delete a
photograph they added, not only move it to the trash, just as the
administrator can. They still cannot touch anybody else's photograph, and they
cannot see one in their trash to try.

### 15.1 Decisions

1. **Permanent deletion follows the same ownership rule as the trash.** A
   family browser may permanently delete a trashed photograph whose
   `uploaderHash` matches its token, and nothing else. That includes one of
   its photographs the administrator trashed (decision 8).
2. **Only from the trash.** A live photograph must be moved to the trash
   first, as for the administrator: no path goes from live to gone in one act.
3. **One photograph at a time, from the trash's photo view.** The family has
   no selection (family-tier.md #5), so the trash's photo view offers
   **Delete permanently** beside **Restore**, behind the same "cannot be
   undone" confirmation the administrator gets. There is no Empty trash.
4. **The admin link is unchanged.** It deletes permanently any trashed
   photograph, from its selection bar.
5. **Supersedes** the statements that permanent deletion is admin-only:
   family-tier.md #4 and 5.4, and this spec's section 5 Trash page intro.

### 15.2 Server

`/permanent-delete/preview` and `/permanent-delete/confirm` move from
`admin.ts` into `netlify/functions/lib/curation-routes.ts`, so both Functions
answer them and `CURATION_ROUTES` lists them. Admin mode behaves exactly as
before. In display mode, as for the trash (6.5):

- `POST /permanent-delete/preview`: no valid token, 404. Selection not
  `{ kind: 'ids' }`, 404. Resolve to trashed photographs and keep only owned
  ones; if none remain, 404. Otherwise issue the token.
- `POST /permanent-delete/confirm`: no valid token, 404. Filter the confirmed
  IDs to owned photographs inside the `mutateCatalog` callback, then delete
  the records, then the objects.

The audit event records `via`. The fixture server applies the same rules.

### 15.3 Client

- `previewPermanentDelete` and `confirmPermanentDelete` move from `adminApi`
  into `curationApi`, which `adminApi` spreads.
- `Capabilities` gains `purge: boolean` and `Curation` gains `purge(id)`.
  Only the family's trash says yes: `TrashPage` sets it where it has a
  `permanentDelete` and no selection. The Lightbox shows **Delete
  permanently** where `can.purge`.
- The family App passes `TrashPage` a `permanentDelete` built on
  `curationApi`.
- The family Trash page intro reads: "Photos added from this device that have
  been deleted are kept here for 30 days, then removed automatically. Tap one
  to look at it and restore it, or delete it permanently."

### 15.4 Tests

- Route tests: display mode permanently deletes an owned trashed photograph,
  record and objects, audited as `display-api`; refuses with the plain 404 an
  unowned trashed photograph, an owned live one, a tokenless preview or
  confirm, and a day selection; cuts a mixed list to the owned photographs;
  and deletes nothing when ownership changed between preview and confirm.
  Admin mode is unchanged.
- The two routes leave the admin-only list, and the whitelist tests reach
  them in both modes.
- Component: Delete permanently appears under the family's trash and calls
  `purge`, and not under the admin's trash or the family's library.
- End to end: the family deletes its own trashed photograph permanently from
  the trash's photo view, and a request naming a photograph it did not add is
  refused.

