# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
npm run dev:display     # viewer,  http://localhost:5173/dev-display-path/
npm run dev:admin       # admin,   http://localhost:5174/dev-admin-path/
npm run dev:harness     # pipeline harness on :5175, needed by pipeline e2e
npm run check           # format:check + lint + typecheck + unit tests
npm run test            # vitest run
npm run test:e2e        # Playwright: chromium, webkit, mobile-safari
npm run build           # both apps, into dist/<secret-path>/
```

Single tests:

```sh
npx vitest run tests/unit/signing.test.ts
npx vitest run -t '<test name substring>'
npx playwright test tests/e2e/admin.spec.ts --project=chromium
npx playwright test -g 'the detail panel'
```

`npm run typecheck` runs **three** tsconfigs — browser (`tsconfig.json`),
Netlify functions (`tsconfig.functions.json`), and Worker
(`tsconfig.worker.json`). Code in `src/shared/` is compiled by all three, so a
change there can typecheck in the app and fail in the Worker.

`npm run dev` is `netlify dev` and needs the Netlify CLI, which is deliberately
not a dependency (`npx netlify-cli dev`). The three `dev:*` scripts need
nothing beyond `npm install`.

Playwright's `webServer` starts all three dev servers itself, so `npm run
test:e2e` works from a cold start.

**Never read `.env`.** It holds live secrets. Do not `cat` it, source it into a
command, or run anything that would print its values. `.env.example` lists the
variable names.

## Deploying

Two independent targets, and a change to `src/shared/` may need both:

- **Netlify** (apps, edge gate, both Functions) deploys on push to `master`.
  Deploy previews and branch deploys are disabled by design.
- **Cloudflare Worker** (`worker/`) deploys only with `npx wrangler deploy`.

Check what is actually pending rather than assuming — `git log
origin/master..master` and `npx wrangler deployments status`.

## Architecture

All image processing happens in the administrator's browser. The server never
touches image bytes. The browser decodes, orients, converts to sRGB, resizes,
and encodes four artifacts, then PUTs them straight to R2 with presigned URLs;
the admin API only issues those URLs, verifies the objects landed, and updates
the catalog.

Four runtimes share one `src/shared/` model layer:

| Runtime           | Entry                                           | Reaches R2 via                |
| ----------------- | ----------------------------------------------- | ----------------------------- |
| Viewer app        | `src/display/` (own Vite build)                 | —                             |
| Admin app         | `src/admin/` + `src/pipeline/` (own Vite build) | presigned S3 PUTs             |
| Netlify Functions | `netlify/functions/{display,admin}.ts`          | S3 API (`@aws-sdk/client-s3`) |
| Cloudflare Worker | `worker/src/index.ts`                           | native R2 binding             |

There is no database. `catalog/current.json` in the private R2 bucket is the
whole model; every mutation is an ETag-guarded conditional write with
reload-and-retry on conflict.

### The gate is the whole access model

There is no authentication. Two independent high-entropy path segments
(`DISPLAY_PATH`, `ADMIN_PATH`) are the access control, and photo capability
URLs work the same way.

`netlify/edge-functions/gate.ts` runs before everything and is the only thing
that assigns an access mode. It forwards `x-photo-access-mode` plus
`x-photo-gate-secret` (`INTERNAL_GATE_SECRET`); the Functions re-verify both in
`checkAccess()` because `/.netlify/functions/<name>` is directly addressable
and would otherwise accept a self-asserted admin mode.

Every refusal — unknown path, wrong secret, wrong mode, trashed photo, bad
signature, expired signature — is the same plain 404. Preserve that: a
distinguishable response is a probe oracle.

`netlify/lib/routing.ts` holds the routing decision as a pure function and must
stay outside `netlify/edge-functions/`. Netlify bundles _every_ file in that
directory as an edge function and fails the deploy on one without a default
export.

### The two apps are separate builds

`vite.display.config.ts` and `vite.admin.config.ts` are fully independent so no
shared chunk can put admin code under the display path. Nothing in the display
module graph may import from `src/admin/`.

Only the three values in `clientDefines()` (`config/build-env.ts`) are inlined
into a bundle — no `VITE_` prefix auto-inlining, so a secret cannot reach a
browser by being named carelessly. A build with `NETLIFY=true` and a missing
variable throws; a local build warns and uses `dev-display-path` /
`dev-admin-path`.

### The storage seam

`src/shared/store.ts` exists because the two R2 clients report a failed
conditional write in structurally incompatible ways: the S3 path **throws HTTP
412**, the Workers binding **returns `null` without throwing**. Each adapter
(`netlify/functions/lib/s3-store.ts`, `worker/src/binding-store.ts`) translates
to one `ConditionalWriteResult`. Never add a bare try/catch or a bare
did-it-throw check above that seam.

## Local development fake, and how it misleads

`config/fixture-server.ts` mounts the display API, admin API, and asset Worker
in the Vite dev server, running the _real_ projection and mutation code over an
in-memory store. Only storage and image bytes are fake.

It is nonetheless **more permissive than production**, and that has shipped
bugs. Its admin handler falls through to `handleDisplay` for any unrecognized
GET, which hid the admin API missing four read routes entirely — the fix was
`netlify/functions/lib/read-routes.ts`, shared by both functions. When adding a
route, add it to the real function, not just to the fixture server.

## Invariants worth knowing before editing

- **Capture timestamps are camera-local strings, never `Date`.** Reviving a
  zoneless wall-clock time in the parsing machine's timezone shifts
  early-morning photos into the wrong calendar day, which is the entire
  navigation structure. See `src/shared/datetime.ts`. `Date` is only for
  genuine instants (`createdAt`, `trashedAt`).
- **Orientation is decode-path dependent.** libheif already applies HEIF
  `irot`, so EXIF orientation must be _ignored_ for HEIC; `createImageBitmap`
  paths must apply it. `src/pipeline/orientation.ts` decides by comparing the
  decoded shape against the shape the tag describes, not by branching on the
  decoder. Dimension-only assertions cannot catch a double rotation — the
  artifacts stay mutually consistent.
- **Decode and encode are strictly serial**, one file at a time
  (`src/pipeline/index.ts`). `UPLOAD_CONCURRENCY` governs uploads only.
- **`src/shared/` (outside `ui/` and `styles/`) must stay free of DOM, Node,
  and Workers globals** — it is compiled into all three targets.
- **`full` is excluded from `DISPLAY_RENDITIONS`.** The full-resolution JPEG is
  reachable only through a short-lived HMAC-signed URL, never from a photo ID.
- Objects never move. Trash is a catalog field; only permanent deletion or the
  daily cron removes bytes.
- Adding a non-secret env var whose value also appears in the repo may trip
  Netlify's secrets scanner — see `SECRETS_SCAN_OMIT_KEYS` in `netlify.toml`.

## Testing

Unit tests are Vitest, Node environment by default; component tests opt in
per file with a `@vitest-environment happy-dom` docblock.

Conditional-write semantics are tested against `fixtures/in-memory-store.ts`
with explicitly asserted behavior, deliberately **not** Miniflare's emulated R2
(its `onlyIf` handling has been reported inverted). Both conflict shapes must
be covered.

`tests/e2e/pipeline.spec.ts` needs real photographs in `sample-photos/`, which
is gitignored because the repo may be public. Those tests skip when it is
absent rather than passing vacuously. The pipeline cannot be tested under a DOM
shim — it needs real `createImageBitmap`, `OffscreenCanvas`, and WebAssembly,
which is what `vite.harness.config.ts` and `tests/e2e/harness/` are for.

Playwright wipes `test-results/` at the start of a run; anything saved there
from an earlier run is gone.

Firefox is absent from the Playwright projects on purpose: it is unsupported
for admin (roughly 10x slower, crashed on a fourth consecutive file).

## Documentation

`docs/` is a genuine record, not stale scaffolding, and code comments cite it
by number:

|                               |                                                   |
| ----------------------------- | ------------------------------------------------- |
| `docs/design.md`              | What the site is and the rules it follows         |
| `docs/implementation-plan.md` | How it is built                                   |
| `docs/decisions.md`           | Why, including the defects that shaped it         |
| `docs/operations.md`          | Account setup, backup, recovery, launch checklist |

`docs/operations.md` must never contain a real secret path segment or key. Its
command blocks source `.env` into the shell instead, and the values are written
as variable references.
