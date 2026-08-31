# Family photo site

A small, private, curated family photo site: a viewer and an admin app behind
separate unguessable URLs, with photos in a private Cloudflare R2 bucket.

All image processing happens in the administrator's browser. The original file
never leaves the laptop, and because every stored artifact is re-encoded from
decoded pixels, no EXIF or GPS data survives into anything published.

## Documents

|                                                            |                                           |
| ---------------------------------------------------------- | ----------------------------------------- |
| [docs/design.md](docs/design.md)                           | What the site is and the rules it follows |
| [docs/implementation-plan.md](docs/implementation-plan.md) | How it is built                           |
| [docs/decisions.md](docs/decisions.md)                     | Why, including the defects that shaped it |
| [docs/operations.md](docs/operations.md)                   | Setup, backup, recovery, launch checklist |

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
src/display/    viewer app          src/admin/      admin app
src/shared/     model, validation   src/pipeline/   browser image pipeline
netlify/        edge gate + APIs    worker/         R2 gateway + cron
fixtures/       test catalog        scripts/        backup
```

## Secrets

`.env.example` lists variable names only. Nothing real is ever committed: the
repository may be public, and the URL paths are themselves the access control.
