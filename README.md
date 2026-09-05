# Family photo site

A small, private, curated family photo site: a viewer and an admin app behind
separate unguessable URLs, with photos in a private Cloudflare R2 bucket.

All image processing happens in the administrator's browser. The original file
never leaves the laptop, and because every stored artifact is re-encoded from
decoded pixels, no EXIF or GPS data survives into anything published.

The viewer is one scrolling page: the whole library newest first, under year,
month, and day headings, with a Recently Uploaded view alongside it that
groups the last few upload sittings by arrival rather than by capture date.
A single request carries the entire structure, every rendition's pixel
dimensions included, so the layout is final at first paint and a deep link
like `/2026/03/01` scrolls straight to its section without reflowing.

## Documents

Note: These (like everything in this README except this paragraph) are AI-generated
and should be considered a historical record of design decisions made during
implementation. They might be out of date. The code is the source of truth, and I
will try to keep this README as up to date as possible.

|                                                            |                                           |
| ---------------------------------------------------------- | ----------------------------------------- |
| [docs/design.md](docs/design.md)                           | What the site is and the rules it follows |
| [docs/implementation-plan.md](docs/implementation-plan.md) | How it is built                           |
| [docs/decisions.md](docs/decisions.md)                     | Why, including the defects that shaped it |
| [docs/operations.md](docs/operations.md)                   | Setup, backup, recovery, launch checklist |

`docs/specs/` and `docs/infinite-scroll-design-overhaul.md` are per-change
implementation specs, each written before the work it describes and not
revised afterwards.

## Getting started

No Cloudflare or Netlify account is needed to run or test anything locally.

```sh
npm install
npm run dev:display   # viewer, http://localhost:5173/dev-display-path/
npm run dev:admin     # admin,  http://localhost:5174/dev-admin-path/
npm run check         # format, lint, typecheck, unit tests
npm run test:e2e      # Playwright: Chromium, WebKit, mobile Safari
```

A local fake serves the display API, the admin API, and the asset Worker in
process, running the real projection and mutation code over an in-memory
store. See [docs/operations.md](docs/operations.md).

The browser-pipeline tests need real photographs in `sample-photos/`, which is
gitignored because this repository may be public; those tests skip when it is
absent.

## Layout

```text
src/shared/ui/  the whole viewer UI, which both apps render
src/shared/     catalog model, projections, signing, validation
src/display/    viewer entry        src/admin/      viewer plus curation
src/pipeline/   browser pipeline    config/         build env + local fake
netlify/        edge gate + APIs    worker/         R2 gateway + cron
fixtures/       test catalog        scripts/        backup
```

The admin is not a second interface: it is the viewer plus curation. Both
apps render the same pages out of `src/shared/ui/` and read the same two
routes, `/timeline` and `/photo/<id>`. The admin adds selecting, editing,
trashing, and uploading by providing a `CurationContext`; the viewer provides
`null`, so its bundle carries the branches that test for it and never the
admin modules. Nothing under `src/shared/` imports from either app, and the
two Vite builds are fully independent, so no shared chunk can put admin code
under the display path.

## Deploying

Two independent targets, deployed two different ways. Neither deploy touches
the other, and one change can need both — see
[which change needs which](#which-change-needs-which-deploy) below.
[docs/operations.md](docs/operations.md) covers first-time account setup;
this is the routine case, once the site and the Worker already exist.

### Netlify: both apps, the edge gate, both Functions

Netlify is Git-connected, so pushing to `master` **is** the deploy:

```sh
npm run check          # format, lint, typecheck, unit tests
git push origin master
```

Netlify then runs `npm run build` (the two independent Vite builds, into
`dist/<secret-path>/`), bundles `netlify/functions/` with esbuild, and
publishes `netlify/edge-functions/gate.ts` in front of everything.

Deploy previews and branch deploys are disabled by design, in both
`netlify.toml` and the site settings, so pushing any other branch deploys
nothing. Testing happens locally; production is the only deploy target.

Environment variables live in the Netlify site settings, never in the
repository — `.env` is local only and is never deployed. They are read at
build time, so **changing one in the Netlify UI does nothing until a build
runs**; trigger a redeploy from the Netlify dashboard rather than waiting for
the next push. That matters most for the three values inlined into the client
bundles by `clientDefines()` (`config/build-env.ts`): the app base path,
`WORKER_BASE_URL`, and `SITE_TITLE`.

To see what is pending: `git log origin/master..master`.

### Cloudflare: the asset Worker and the daily cron

The Worker is **not** Git-connected. Nothing about a push deploys it; it goes
out only when you run wrangler by hand from the repository root:

```sh
npx wrangler deploy
```

`wrangler` is a devDependency, so there is nothing to install globally. On a
new machine (or after the CLI's stored credentials expire) authenticate first:

```sh
npx wrangler login     # browser OAuth against your Cloudflare account
npx wrangler whoami    # confirms which account is about to be deployed to
```

The whole configuration is `wrangler.toml` at the repository root: the Worker
name (`photo-assets`), its entry point (`worker/src/index.ts`), the `PHOTOS`
R2 binding, the `CATALOG_CACHE_SECONDS` var, and the `17 4 * * *` cron
trigger. Editing any of those — including the cron schedule — takes effect on
the next `npx wrangler deploy`.

The one secret, `ASSET_SIGNING_KEY`, is deliberately absent from that file. It
is set out of band, and only on an already-deployed Worker:

```sh
npx wrangler secret put ASSET_SIGNING_KEY
```

To see what is live, and to watch it: `npx wrangler deployments status` and
`npx wrangler tail`.

### Which change needs which deploy

| Changed                                                         | Netlify | Cloudflare |
| --------------------------------------------------------------- | ------- | ---------- |
| `src/display/`, `src/admin/`, `src/pipeline/`, `src/shared/ui/` | ✅      | —          |
| `netlify/` — Functions, the edge gate, `routing.ts`             | ✅      | —          |
| Vite configs, `config/`, `index.html`, `public/`, dependencies  | ✅      | —          |
| Netlify environment variables (redeploy to pick them up)        | ✅      | —          |
| `worker/`                                                       | —       | ✅         |
| `wrangler.toml` — vars, the cron schedule, the R2 binding       | —       | ✅         |
| `src/shared/` (outside `ui/` and `styles/`)                     | ✅      | ✅         |

The last row is the one that gets forgotten. Every module the Worker imports
is also compiled into the Netlify Functions — `catalog.ts`,
`catalog-repository.ts`, `admin-operations.ts`, `store.ts`, `signing.ts`,
`audit.ts`, `headers.ts`, `ids.ts`, `constants.ts` — so a change to any of
them that ships to only one target leaves the two runtimes disagreeing about
the same catalog.

`signing.ts` is the sharpest case: the Netlify admin function signs
full-resolution URLs and the Worker verifies them. Deploy one side without
the other and every full-size photo 404s, indistinguishably from any other
refusal. Deploy both, close together.

Neither deploy is needed for `docs/`, `tests/`, `fixtures/`, or `CLAUDE.md`.

## Secrets

`.env.example` lists variable names only. Nothing real is ever committed: the
repository may be public, and the URL paths are themselves the access control.
