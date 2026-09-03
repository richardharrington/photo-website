# Operations

How to set this site up, run it, and recover it. The design is in
[design.md](design.md), the plan in
[implementation-plan.md](implementation-plan.md), and the reasoning behind the
architecture in [decisions.md](decisions.md).

**Status, 2026-08-31.** [Account setup](#account-setup) steps 1 to 7 have
been carried out against live Cloudflare and Netlify accounts and the site is
deployed. What remains is the [launch checklist](#launch-checklist) and the
[backup](#backup) configuration. Those steps stay written as checklists
because they are worth re-running after any change to the gate, the Worker, or
the account configuration — not because they have never been done.

## Local development

No account of any kind is needed.

```sh
npm install
npm run dev:display   # viewer,  http://localhost:5173/dev-display-path/
npm run dev:admin     # admin,   http://localhost:5174/dev-admin-path/
npm run dev:harness   # pipeline harness for the browser tests
npm run check         # format, lint, typecheck, unit tests
npm run test:e2e      # Playwright, Chromium + WebKit + mobile Safari
```

`config/fixture-server.ts` mounts a stand-in for the display API, the admin
API, and the asset Worker directly in the Vite dev server. It runs the *real*
projection and mutation code over an in-memory object store, so the contract
and the conditional-write logic being exercised are the production ones; only
the storage and the image bytes are fake.

The development builds print a warning and use placeholder path segments. A
build with `NETLIFY=true` and a missing variable fails instead, so a real
deploy cannot fall back to a guessable path.

`npm run dev` is `netlify dev`, which needs the Netlify CLI. It is deliberately
not a dependency of this project — it is a large install and nothing in the
test suite needs it — so run it through `npx netlify-cli dev`, or install the
CLI globally, if you want the edge gate in the loop locally. The three `dev:*`
scripts need none of that.

### Image pipeline fixtures

`tests/e2e/pipeline.spec.ts` needs real photographs, which are **not** in the
repository — `sample-photos/` is gitignored because the repository may be
public. Those tests skip when the directory is absent rather than passing
vacuously.

The four fixtures used during development were Apple HEICs: two portrait with
`Orientation: 6` and genuine GPS coordinates, one landscape with
`Orientation: 1`, and one with no orientation tag. All four are Display P3.
Any similar set works; the tests read what they need from the files.

## Account setup

Everything below must be done once, before the first production deploy. The
site must run entirely on free tiers.

The steps are in dependency order, and each item names the console it is done
in. Two orderings are forced and are easy to get wrong:

- **The shared secrets are generated before either provider is touched**
  (step 2). `ASSET_SIGNING_KEY` must be the *same* value in Netlify and in the
  Worker, so it cannot be invented inside whichever one is configured second.
- **Each provider needs something from the other.** Netlify's environment
  needs the R2 credentials and the Worker URL; the bucket's CORS rule needs
  the production Netlify origin. The cycle is broken by building the whole
  Cloudflare side first except CORS, creating the Netlify site to get an
  origin (step 6), and setting CORS against it afterwards (step 7).

### 1. Accounts and spend limits

- [x] **Cloudflare** — create the account with a unique password-manager
      credential and passkey or authenticator MFA — **not SMS** where a choice
      exists. Store the recovery codes securely.
- [x] **Netlify** — create the account with the same credential hygiene.
- [x] **Cloudflare** — configure a spend alert with a small monthly threshold.
- [x] **Netlify** — configure a spend alert.
- [x] Re-check the current free-tier limits: R2 storage, Class A/B
      operations, and Worker requests. Measured usage is roughly 2–5 MB per
      photo across all four artifacts, about 0.9 GB/year at 300 photos/year,
      against a 10 GB free tier.

### 2. Create `.env` and generate the shared secrets

Local only — no account is involved. These values are inputs to both
providers, so they come first.

`.env` is gitignored and is never deployed. Netlify reads its own copy of
these values from the site configuration in step 6, and the Worker gets the
one secret it needs in step 4. The local file is the working copy those are
pasted from, and the one `netlify dev` reads.

- [x] `cp .env.example .env`, then `chmod 600 .env`.
- [x] Fill in the five values that need no account. Generate each one with its
      own command — never reuse a value across two variables:

  - `DISPLAY_PATH` — `openssl rand -hex 16`. A single path segment, no `/`;
    the build refuses one containing a slash.
  - `ADMIN_PATH` — `openssl rand -hex 16`, run a second time. A separate draw,
    not a transformation of the display path.
  - `INTERNAL_GATE_SECRET` — `openssl rand -hex 32`. Hex rather than base64:
    it travels as an HTTP header value between the edge gate and the
    functions.
  - `ASSET_SIGNING_KEY` — `openssl rand -base64 32`. Used as raw UTF-8 key
    material for HMAC-SHA-256, so base64's own alphabet is fine here.
  - `SITE_TITLE` — the viewer-facing title. The shipped default,
    `Family Photos`, needs no change.

  Generating all four secrets at once, to paste into the file:

  ```sh
  echo "DISPLAY_PATH=$(openssl rand -hex 16)"
  echo "ADMIN_PATH=$(openssl rand -hex 16)"
  echo "INTERNAL_GATE_SECRET=$(openssl rand -hex 32)"
  echo "ASSET_SIGNING_KEY=$(openssl rand -base64 32)"
  ```

- [x] Confirm `DISPLAY_PATH` and `ADMIN_PATH` are independent random values.
      Neither may be derivable from the other, and the gate refuses to serve
      anything if they are equal.
- [ ] Leave the five `R2_*` variables empty until step 3, and
      `WORKER_BASE_URL` empty until step 4. They only have to be filled in by
      the time step 6 sets the Netlify environment. Note that the two are
      needed at different moments: `WORKER_BASE_URL` is inlined at build time,
      so a real deploy without it fails outright, while the `R2_*` values are
      read per request and a mistake there surfaces as failing API calls on a
      site that built cleanly.
- [ ] Keep `ASSET_SIGNING_KEY` to hand. It goes into the Worker in step 4 and
      into Netlify in step 6, and the two must match.

### 3. Cloudflare: bucket and credentials

- [ ] Create the R2 bucket, named to match `bucket_name` in `wrangler.toml`.
      Keep it **private**; nothing in this design ever makes it public.
- [ ] Create the S3-compatible API token at
      `https://dash.cloudflare.com/<account-id>/r2/api-tokens`, reached from
      **R2 Object Storage → API → Manage API tokens → Create API token**.

  This must be the R2 page. **Manage account → Account API tokens** is a
  different flow that looks plausible and is wrong: it offers account-wide
  templates such as "Read all resources" (190 permissions) with no R2
  object permission and no bucket picker, and it ends by showing a single
  token string rather than an access key and secret. If that is what you
  are looking at, back out. Cloudflare renames these controls from time to
  time; what matters is the effect described for each.

  - **Token type.** If offered a choice between an account token and a user
    token, take the account one. A user token inherits one member's
    permissions and stops working if that membership or role changes; this
    credential should outlive any individual.
  - **Permission: Object Read & Write.** Not `Admin Read & Write`, and not
    either read-only option. The functions call exactly `GetObject`,
    `HeadObject`, `PutObject`, `ListObjectsV2`, and `DeleteObjects`
    (`netlify/functions/lib/s3-store.ts`), all of them object operations
    inside a bucket that already exists. Nothing creates, deletes, or
    reconfigures a bucket, so admin rights would only widen what a leaked
    key can do. CORS is set through the dashboard in step 7, not through
    this token.
  - **Scope: "Apply to specific buckets only"**, then select the bucket
    created above. Not "Apply to all buckets in this account" — that grants
    the token every bucket the account will ever hold, including ones
    created later for unrelated purposes.
  - **TTL: no expiry.** Nothing here rotates credentials automatically, so
    an expiring token becomes a silent outage: uploads and every catalog
    write start failing at a date chosen months earlier. Prefer rotating
    deliberately when there is a reason to. If a TTL is set anyway, record
    the expiry date somewhere that will be read.
  - **Client IP filtering: leave empty.** The callers are Netlify Functions,
    whose egress addresses are neither stable nor published, so an allowlist
    here fails intermittently and looks like a bug in the site.

- [ ] Map the four values Cloudflare shows on creation. Only three of them
      belong in `.env`, and the secret is displayed **once** — a lost one
      cannot be recovered, only replaced.

  - **Token value** — goes nowhere. It is the bearer credential for R2's
    REST API, and nothing in this repository uses it; every call here goes
    through the S3-compatible API instead. It is still a live credential
    against the same bucket with the same permissions, so keep it in the
    password manager or discard it — but do not paste it into `.env`, where
    it would sit unused as one more thing to leak.
  - **Access Key ID** → `R2_ACCESS_KEY_ID`.
  - **Secret Access Key** → `R2_SECRET_ACCESS_KEY`.
  - **Endpoint** → `R2_S3_ENDPOINT`. The page lists one endpoint per
    jurisdiction; take the one labelled **Default** unless the bucket was
    deliberately created in a jurisdiction such as the EU, in which case the
    endpoint must match the bucket. It is of the form
    `https://<account-id>.r2.cloudflarestorage.com`, and must be copied with
    **no bucket name appended and no trailing slash**. The SDK appends
    `/<bucket>/<key>` itself, so a bucket already in the value yields a
    doubled path; the edge gate also derives the admin app's CSP
    `connect-src` origin from it (`netlify/edge-functions/gate.ts:77`), and
    a wrong origin means the browser blocks uploads with nothing failing
    server-side to point at the cause.

  Also fill in `R2_BUCKET` with the bucket name, and `R2_ACCOUNT_ID` with
  the account ID — the same hex string that appears in the endpoint
  hostname. Nothing in this repository reads `R2_ACCOUNT_ID`; it is kept
  because the `rclone` remote in [Backup](#backup) is configured by hand
  against the same account and endpoint.

- [ ] Optionally confirm the four R2 values before going further. A mistake
      is far easier to diagnose here than inside step 5, or after a deploy.
      From the repository root, on Node 20.6 or newer:

  ```sh
  node --env-file=.env --input-type=module -e '
    import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";
    const client = new S3Client({
      region: "auto",
      endpoint: process.env.R2_S3_ENDPOINT,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
    const out = await client.send(
      new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET }),
    );
    console.log("ok:", out.KeyCount ?? 0, "objects");
  '
  ```

  This needs nothing that is not already installed: `@aws-sdk/client-s3` is
  a dependency of this project, because R2's S3-compatible API is how the
  Netlify functions reach the bucket. The client is constructed exactly as
  `netlify/functions/lib/s3-store.ts` constructs it and reads the same four
  variables straight out of `.env`, so a pass here means the real adapter
  will connect. A fresh bucket prints `ok: 0 objects`.

  `wrangler` cannot stand in for this check. It authenticates as your
  Cloudflare login and would prove only that the account exists — not that
  the token, its bucket scope, or the endpoint are right.

  When it fails, the error usually points at one variable:

  - A rejected or mismatched key (`InvalidAccessKeyId`,
    `SignatureDoesNotMatch`) — `R2_ACCESS_KEY_ID` or
    `R2_SECRET_ACCESS_KEY`, or a token that was scoped read-only.
  - `AccessDenied` — the token is valid but not scoped to this bucket, so
    re-check "Apply to specific buckets only".
  - `NoSuchBucket` — `R2_BUCKET`, or an `R2_S3_ENDPOINT` that already
    carries the bucket name and so asks for it twice.
  - A DNS or TLS error — `R2_S3_ENDPOINT`, most often the wrong
    jurisdiction or a typo in the account ID.

  A pass does not confirm the permission, only the credentials, the
  endpoint, and the bucket scope: listing succeeds under `Object Read only`
  too. Step 5 is what catches that, since its checks are writes — so an
  `AccessDenied` there, where a `412` was expected, means the token
  permission rather than the conditional-write semantics.

CORS is deliberately not set here. It names an origin that does not exist yet
— see step 7.

### 4. Cloudflare: deploy the Worker

The Worker binds the R2 bucket, so the bucket must already exist.

- [ ] `npx wrangler deploy`, and note the `workers.dev` URL — this is
      `WORKER_BASE_URL` for step 6. No custom domain is needed.
- [ ] `npx wrangler secret put ASSET_SIGNING_KEY`, using the value from
      step 2. A secret can only be set on a deployed Worker.
- [ ] Confirm the daily cron trigger is registered (`wrangler.toml`,
      `17 4 * * *`).

### 5. Verify R2 conditional writes against the live bucket

Needs the bucket, the S3 token, and the deployed Worker — the four checks
exercise both write paths.

- [ ] Work through
      [Conditional-write verification](#conditional-write-verification) below.

Do this before deploying Netlify. The documented fallback changes how every
catalog mutation is routed, and that is far cheaper to discover now.

### 6. Netlify: site and environment

- [ ] Create the site and note its production origin. Step 7 needs it.
- [ ] **Disable deploy previews and branch deploys in the site settings.**
      `netlify.toml` skips those builds, but the UI setting is the real
      control.
- [ ] Set the environment variables: the generated secrets from step 2, the
      R2 values from step 3, `WORKER_BASE_URL` from step 4, and `SITE_TITLE`.

  `SITE_TITLE` is easy to skip because `.env.example` ships a default, but the
  default applies only to local builds: `resolveBuildEnv` throws on a real
  deploy when it is unset, exactly as it does for the path segments
  (`config/build-env.ts`). `R2_ACCOUNT_ID` is the one value that can be left
  out, since no code reads it.

  Set these **before the first build runs**, whether in the create-site flow
  or by connecting the repository only afterwards. Connecting a repository
  triggers a build immediately, and a build with these unset fails by design —
  an expected red X rather than a broken site, but an alarming one if
  unexpected.

Notes on the site itself, learned doing this:

- **Create the GitHub repository first.** The deploy model here is
  Git-connected — `netlify.toml` carries `[context.deploy-preview]` and
  `[context.branch-deploy]` blocks, which mean nothing otherwise. A site can
  be created without a provider and linked later, but that is two passes over
  the same settings.
- **Change nothing in the UI build settings.** `netlify.toml` pins the build
  command, publish directory, functions directory, `NODE_VERSION`, the
  bundler, and the edge function, and it takes precedence over the UI. Setting
  a build command there too only creates a second source of truth.
- **Settle the site name before step 7.** The name is the production origin,
  and step 7's CORS rule pins that exact origin; renaming afterwards means
  editing the bucket rule to match.

### 7. Cloudflare: bucket CORS

Back in the Cloudflare console, now that there is a Netlify origin to name.

- [ ] Add the CORS policy on the bucket, under **R2 → the bucket → Settings
      → CORS Policy**:

  ```json
  [
    {
      "AllowedOrigins": ["https://<your-site>.netlify.app"],
      "AllowedMethods": ["PUT"],
      "AllowedHeaders": ["content-type"],
      "MaxAgeSeconds": 3600
    }
  ]
  ```

  The browser uploads are `cors`-mode fetches, so a real `Origin` header is
  sent even under `Referrer-Policy: no-referrer` — this rule does work, unlike
  an origin check on image loads.

  It is deliberately narrower than most CORS advice. `uploadArtifact` in
  `src/admin/components/Upload.tsx` is the only request in either app that
  leaves the site's origin: it sends one header, `content-type`, uses `PUT`
  alone, and reads only `response.ok`. So there is no `GET` here — reads go
  through the Worker and the bucket stays private — and no `ExposeHeaders`,
  which guides commonly add for `ETag`. A `PUT` carrying an image content type
  is never a simple request, so every upload is preceded by an `OPTIONS`
  preflight that R2 answers from this rule.

- [ ] Confirm the rule with a preflight. It is unauthenticated, so this needs
      no credentials:

  ```sh
  curl -si -X OPTIONS "https://<account-id>.r2.cloudflarestorage.com/<bucket>/probe" \
    -H "Origin: https://<your-site>.netlify.app" \
    -H "Access-Control-Request-Method: PUT" \
    -H "Access-Control-Request-Headers: content-type"
  ```

  Expect `204` with `Access-Control-Allow-Origin` echoing your origin rather
  than `*`, `Allow-Methods: PUT`, `Allow-Headers: content-type`, and
  `Vary: Origin` — the last confirming R2 will not serve that allow to a
  different origin.

Uploads fail until this is in place, so it must precede the launch checklist's
end-to-end upload. A custom domain later would be a second origin and would
have to be added here, or uploads break from the new hostname while continuing
to work from the old one.

### 8. Deploy

- [ ] Deploy, then walk the [launch checklist](#launch-checklist).

### Conditional-write verification

Both write surfaces support ETag-guarded writes, but they report a conflict in
structurally different ways, and the adapters translate each to one normalized
result (decisions.md #22). The unit tests pin both translations against an
in-memory fake with explicitly asserted semantics — deliberately **not**
Miniflare, whose `onlyIf` handling has been reported inverted
(`workers-sdk#6411`, closed as not planned), so a backwards implementation
could pass against it.

What remains is to confirm the real bucket behaves as documented. Four checks,
against a scratch key rather than `catalog/current.json` — at this point in the
setup the catalog does not exist yet, and a verification run has no business
creating it. Both scratch files must be written **inside the repository**, so
that Node resolves `node_modules` and wrangler picks up the project context;
both are deleted at the end, and `git status` should be clean afterwards.

Note that the maintenance cron sweeps only the `photos/` and
`catalog/snapshots/` prefixes, so a `_verify/` object left behind by an aborted
run is never cleaned up automatically. Delete it by hand if a run does not
reach its own cleanup line.

#### Checks 1–3: the S3 path, as the Netlify functions see it

Write the script to the repository root:

````sh
cat > verify-s3.mjs <<'EOF'
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";

const Bucket = process.env.R2_BUCKET;
const Key = "_verify/conditional-write";
const client = new S3Client({
  region: "auto",
  endpoint: process.env.R2_S3_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const put = (Body, extra = {}) =>
  client.send(
    new PutObjectCommand({
      Bucket,
      Key,
      Body,
      ContentType: "text/plain",
      ...extra,
    }),
  );
const show = (e) =>
  `${e?.name ?? "Error"} / HTTP ${e?.$metadata?.httpStatusCode ?? "?"}`;

const seeded = await put("one");
const stale = seeded.ETag;

try {
  const fresh = await put("two", { IfMatch: stale });
  console.log(
    fresh.ETag && fresh.ETag !== stale
      ? `1 PASS  If-Match on the current ETag succeeded, new ETag ${fresh.ETag}`
      : `1 FAIL  succeeded but the ETag did not change (${fresh.ETag})`,
  );
} catch (error) {
  console.log(
    `1 FAIL  If-Match on the current ETag was rejected: ${show(error)}`,
  );
}

try {
  await put("three", { IfMatch: stale });
  console.log(
    "2 FAIL  a stale If-Match was accepted; the write was not guarded",
  );
} catch (error) {
  const status = error?.$metadata?.httpStatusCode;
  console.log(
    status === 412
      ? `2 PASS  stale If-Match rejected with ${show(error)}`
      : `2 FAIL  expected HTTP 412, got ${show(error)}`,
  );
}

try {
  await put("four", { IfNoneMatch: "*" });
  console.log(
    "3 FAIL  If-None-Match:* overwrote an object that already exists",
  );
} catch (error) {
  const status = error?.$metadata?.httpStatusCode;
  console.log(
    status === 412 || status === 409
      ? `3 PASS  If-None-Match:* rejected with ${show(error)}`
      : `3 FAIL  expected a conflict, got ${show(error)}`,
  );
}

await client.send(
  new DeleteObjectsCommand({ Bucket, Delete: { Objects: [{ Key }] } }),
);
console.log(`cleaned up ${Key}`);
EOF
````

Run it, then remove it:

```sh
node --env-file=.env verify-s3.mjs
rm verify-s3.mjs
```

Expected output, one line per check:

```text
1 PASS  If-Match on the current ETag succeeded, new ETag "..."
2 PASS  stale If-Match rejected with PreconditionFailed / HTTP 412
3 PASS  If-None-Match:* rejected with ... / HTTP 412
cleaned up _verify/conditional-write
```

Check 3 may report HTTP 409 rather than 412 and still pass; S3-compatible
implementations differ, which is why `isPreconditionFailure` in
`netlify/functions/lib/s3-store.ts` accepts the `ConditionalRequestConflict`
name as well as the status.

#### Check 4: the Workers binding, as the Worker sees it

This one cannot be done from the S3 path or from `wrangler dev` on its own —
it needs the R2 binding, running against the real bucket. `--remote` is what
makes that true: a plain `wrangler dev` would put Miniflare's emulated R2 in
the way, which is the one thing this whole check exists to avoid.

Write the Worker and its own wrangler config to the repository root:

````sh
cat > verify-binding.ts <<'EOF'
interface Env {
  PHOTOS: R2Bucket;
}

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    const key = "_verify/binding-write";

    const first = await env.PHOTOS.put(key, "one");
    const stale = first!.etag;
    await env.PHOTOS.put(key, "two");

    let returned: string;
    let threw: string | null = null;
    try {
      const result = await env.PHOTOS.put(key, "three", {
        onlyIf: { etagMatches: stale },
      });
      returned = result === null ? "null" : "an R2Object";
    } catch (error) {
      returned = "nothing";
      threw = String(error);
    }

    await env.PHOTOS.delete(key);

    const pass = returned === "null" && threw === null;
    return Response.json({
      verdict: pass ? "4 PASS" : "4 FAIL",
      returned,
      threw,
    });
  },
};
EOF

cat > verify-binding.toml <<'EOF'
name = "verify-conditional"
main = "verify-binding.ts"
compatibility_date = "2026-08-01"

# Must match bucket_name in wrangler.toml.
[[r2_buckets]]
binding = "PHOTOS"
bucket_name = "family-photos"
EOF
````

Start it against the live bucket, and in a second terminal call it once:

```sh
npx wrangler dev --remote -c verify-binding.toml   # prints a localhost URL
curl -s http://localhost:8787
```

Expected:

```json
{ "verdict": "4 PASS", "returned": "null", "threw": null }
```

`"returned": "an R2Object"` means the stale ETag was accepted and the write was
not guarded. `"threw"` non-null means this surface raises where the adapter
expects a return value — the case `worker/src/binding-store.ts` is written
around, and the reason it cannot be a try/catch like the S3 one.

Stop the dev session with Ctrl-C, then:

```sh
rm verify-binding.ts verify-binding.toml
```

If any of these differ, the documented fallback is to route every catalog
mutation through a single Worker endpoint, which serializes them.

**Run against the live bucket on 2026-08-31: all four behaved as documented.**
The S3 path returns 412 on a stale `If-Match`, the binding returns `null`
without throwing, and `If-None-Match: *` is refused against an existing
object. The fallback is not needed, and the two adapters stand as written.

## Backup

The main archives remain Dropbox and Google Photos; this site is a curated
subset, and the irreplaceable part is the curation and metadata rather than the
pixels.

- [ ] Install `rclone` and configure an `r2-photos` remote in the user profile
      (`~/.config/rclone/rclone.conf`), with restricted file permissions.
- [ ] Point `PHOTO_BACKUP_DEST` at encrypted local storage.
- [ ] Edit the two `CHANGEME` paths in
      `scripts/com.family.photo-backup.plist`, copy it to
      `~/Library/LaunchAgents/`, and `launchctl load` it.
- [ ] Run `scripts/backup.sh` by hand once and confirm it completes and logs.
- [ ] Confirm the schedule lands **before** IDrive's nightly run.

`scripts/backup.sh` is an exact mirror, on purpose: anything permanently
deleted or purged from R2 disappears locally on the next run, and IDrive
provides the historical copy. Because trashed photos' objects stay in place,
the mirror includes the full 30-day trash along with the catalog, its
snapshots, and the audit log.

Two guards exist because a backup that quietly stops working is worse than
none, since it is trusted:

- `--max-delete` refuses a run that wants to delete an implausible number of
  files, which is far more likely to be a misconfigured remote than a real
  mass deletion.
- A completed mirror with no `catalog/current.json` is treated as a failure,
  because a mirror without the catalog is not a usable restore point whatever
  else it contains.

Failures log and raise a macOS notification.

## Recovery

There is deliberately no in-app import and no maintenance mode. With a single
administrator, "make no edits until the restore is complete" is a runbook line,
and a violation of it surfaces loudly as a conditional-write conflict rather
than as silent loss (decisions.md #14).

Recovery inputs, in rough order of convenience: the local `rclone` mirror, the
catalog JSON export from the admin app, the `catalog/snapshots/` objects in
R2, the audit log, and finally the source archives in Dropbox and Google
Photos.

**Order matters.** Restore in this sequence:

1. **Make no admin edits from this point until the restore is finished.**
2. Restore the matching `photos/<id>/` objects first. A catalog entry pointing
   at objects that do not exist yields broken images; an object with no
   catalog entry is invisible and is swept by the cron after 24 hours.
3. Only then replace `catalog/current.json`, as a conditional write against
   its current ETag. If that write conflicts, someone edited during the
   restore — reload and redo the merge rather than forcing it.
4. Confirm the Worker serves a few restored photos. It caches the catalog for
   about a minute, so allow for that.

To recover a single photo, take its record from a snapshot and its objects
from the mirror; the record's `derivatives` descriptors say what should be
there.

## Launch checklist

Run against production after the first deploy.

Most of these are commands. They need the two secret path segments, which must
not be typed into a shell — they would land in history, and they are the whole
access model. Load them from `.env` instead, and name the site once:

```sh
set -a; . ./.env; set +a
SITE="https://<your-site>.netlify.app"
```

That puts `$DISPLAY_PATH`, `$ADMIN_PATH`, and `$WORKER_BASE_URL` in the
environment of that shell only. Everything below assumes them, plus `$SITE`.

The first group needs nothing but a deployed site. The second needs one real
photograph in the library, so begin it with the upload, which is what yields
the photo ID the rest of that group uses.

### Reachable before any photo exists

- [ ] **Wrong paths return a plain 404 that reveals no route information.**

  ```sh
  for path in / /admin /api /index.html /assets/index.js /.netlify/functions/display; do
    printf '%-34s %s\n' "$path" "$(curl -s -o /dev/null -w '%{http_code}' "$SITE$path")"
  done
  curl -s "$SITE/nope"; echo
  ```

  Every status `404`, and the body exactly `Not Found` — no framework page, no
  hint that a display or admin route exists.

- [ ] **`/robots.txt` is served and disallows everything.**

  ```sh
  curl -si "$SITE/robots.txt" | sed -n '1p'
  curl -s "$SITE/robots.txt"
  ```

  `200`, then `User-agent: *` and `Disallow: /`. This is the only thing
  reachable outside a secret path.

- [ ] **The admin function is unreachable directly, including with a forged
      access-mode header.**

  ```sh
  curl -s -o /dev/null -w 'plain:  %{http_code}\n' "$SITE/.netlify/functions/admin"
  curl -s -o /dev/null -w 'forged: %{http_code}\n' \
    -H 'x-photo-access-mode: admin' "$SITE/.netlify/functions/admin"
  ```

  Both `404`. The second is the important one: the mode header is only
  trustworthy because the gate's shared marker proves the gate set it, and
  this proves an outside caller cannot simply claim it.

- [ ] **Each app is served on its own path.**

  ```sh
  curl -s -o /dev/null -w 'display: %{http_code}\n' "$SITE/$DISPLAY_PATH/"
  curl -s -o /dev/null -w 'admin:   %{http_code}\n' "$SITE/$ADMIN_PATH/"
  ```

  Both `200`.

- [ ] **The display app's HTML and JS contain no occurrence of the admin
      path.**

  ```sh
  html=$(curl -s "$SITE/$DISPLAY_PATH/")
  printf '%s' "$html" | grep -q "$ADMIN_PATH" \
    && echo "FAIL  admin path in HTML" || echo "PASS  HTML clean"
  for asset in $(printf '%s' "$html" | grep -oE '/[A-Za-z0-9_./-]+\.js' | sort -u); do
    curl -s "$SITE$asset" | grep -q "$ADMIN_PATH" \
      && echo "FAIL  admin path in $asset" || echo "PASS  $asset clean"
  done
  ```

  Every line `PASS`. This is the check that the separate Vite builds are doing
  their job: nothing in the display build's module graph may reach `src/admin`.

- [ ] **Every response carries the security headers**, on pages and API
      responses here; images are covered by the Worker check below.

  ```sh
  for url in "$SITE/$DISPLAY_PATH/" "$SITE/$DISPLAY_PATH/api/timeline" "$SITE/robots.txt"; do
    echo "== $url"
    curl -sI "$url" | grep -iE '^(x-robots-tag|referrer-policy|x-content-type-options):'
  done
  ```

  Each should show `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet`,
  `Referrer-Policy: no-referrer`, and `X-Content-Type-Options: nosniff`.

- [ ] **The HTML carries the strict CSP, and the display CSP contains neither
      `wasm-unsafe-eval` nor the R2 origin.**

  ```sh
  display_csp=$(curl -sI "$SITE/$DISPLAY_PATH/" | grep -i '^content-security-policy:')
  admin_csp=$(curl -sI "$SITE/$ADMIN_PATH/" | grep -i '^content-security-policy:')

  printf '%s' "$display_csp" | grep -q "wasm-unsafe-eval" \
    && echo "FAIL  display allows wasm" || echo "PASS  display has no wasm-unsafe-eval"
  printf '%s' "$display_csp" | grep -q "r2.cloudflarestorage.com" \
    && echo "FAIL  display names R2" || echo "PASS  display has no R2 origin"
  printf '%s' "$admin_csp" | grep -q "wasm-unsafe-eval" \
    && echo "PASS  admin allows wasm" || echo "FAIL  admin missing wasm-unsafe-eval"
  printf '%s' "$admin_csp" | grep -q "r2.cloudflarestorage.com" \
    && echo "PASS  admin names R2" || echo "FAIL  admin missing R2 origin"

  printf '%s\n' "$display_csp"
  ```

  All four `PASS`. The asymmetry is the point: only the admin app compiles
  WASM codecs and uploads to R2, so only its policy may permit either. Read
  the printed policy too — `frame-ancestors 'none'`, `base-uri 'none'`,
  `form-action 'none'`, and no `unsafe-inline` anywhere.

### After uploading one real photograph

- [ ] **Upload a real photo end to end from the administrator's own device.**
      Browser work: open `$SITE/$ADMIN_PATH/`, add a photo, watch it commit.
      Then capture its ID for the checks below.

  ```sh
  PHOTO_ID=$(curl -s "$SITE/$ADMIN_PATH/api/export" \
    | python3 -c 'import json,sys; print(next(iter(json.load(sys.stdin)["photos"])))')
  echo "$PHOTO_ID"
  ```

- [ ] **The full-resolution original is not reachable by knowing the ID, and
      images carry the same headers as everything else.**

  ```sh
  for r in thumb display-1280 display-2560 full; do
    printf '%-14s %s\n' "$r" \
      "$(curl -s -o /dev/null -w '%{http_code}' "$WORKER_BASE_URL/p/$PHOTO_ID/$r")"
  done
  curl -sI "$WORKER_BASE_URL/p/$PHOTO_ID/thumb" \
    | grep -iE '^(x-robots-tag|referrer-policy|cache-control):'
  ```

  `200` for the three display renditions and **`404` for `full`** — it is
  reachable only through a signed link. The header check completes the header item
  above, and images are where a robots directive matters most, since an image
  cannot carry a meta tag.

- [ ] **A signed download link works, and stops working after five minutes.**

  ```sh
  signed=$(curl -s "$SITE/$DISPLAY_PATH/api/download/$PHOTO_ID" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["url"])')
  curl -s -o /tmp/full.jpg -w 'immediately: %{http_code}\n' "$signed"
  sleep 310
  curl -s -o /dev/null -w 'after 5m:    %{http_code}\n' "$signed"
  ```

  `200`, then anything but `200`. The TTL is `SIGNED_URL_TTL_SECONDS`, five
  minutes.

- [ ] **The stored artifacts carry no EXIF and no GPS.** Use a source that
      genuinely had coordinates, or the check proves nothing.

  ```sh
  exiftool -a -G1 /tmp/full.jpg | grep -iE 'gps|exif|datetime|make|model' \
    || echo "none present"
  ```

  Without `exiftool`, `strings /tmp/full.jpg | grep -icE 'exif|gps'` should
  print `0`. There should be nothing: every artifact is re-encoded from
  decoded pixels, so this is a property of the pipeline rather than a
  stripping step that could be forgotten.

- [ ] **A portrait photo is upright** in the grid, in the lightbox, and in the
      downloaded original. Browser work, plus `/tmp/full.jpg` from above.

- [ ] **Trashing a photo stops its capability URLs within about a minute, and
      restoring brings them back.** Trash it in the admin app, then:

  ```sh
  for i in 1 2 3 4 5 6; do
    printf '%s  %s\n' "$(date +%T)" \
      "$(curl -s -o /dev/null -w '%{http_code}' "$WORKER_BASE_URL/p/$PHOTO_ID/thumb")"
    sleep 15
  done
  ```

  `200` at first, then `404` once the Worker's catalog cache turns over —
  `CATALOG_CACHE_SECONDS` is 60. Restore it in the admin app afterwards and
  watch the same loop go back to `200`.

### Scheduled work

- [ ] **The Worker's cron handler runs and reports sensibly** against a bucket
      with nothing yet to purge.

  ```sh
  npx wrangler dev --remote --test-scheduled
  # then, in a second terminal:
  curl -s "http://localhost:8787/__scheduled?cron=17+4+*+*+*"
  ```

  `--remote` matters: the point is the real bucket, not an emulated one.

- [ ] **One nightly backup completes and mirrors everything.** Run
      `scripts/backup.sh` by hand, per [Backup](#backup), and confirm the
      destination holds the catalog, the snapshots, the audit log, and the
      photo objects.

## Known gaps

Carried forward from design.md's validation list, and still open:

- **No genuine 48 MP iPhone HEIF Max capture has been tested** — Apple's real
  48 MP tile structure plus an HDR gain map. The 48.8 MP fixture used during
  the spikes was an upsample. Residual risk is low, since a real 48-tile Apple
  grid composited correctly, but the gain-map path is untested.
- **Photos from the administrator's own iPhone have not been through the
  pipeline.** Every fixture was a sample downloaded from the web.
- **Sustained-batch memory has not been measured** beyond a five-file run.
  Check per-file memory release in Chromium and Safari before attempting a
  large batch.
- **Colour conversion has not been bounded against a highly saturated
  wide-gamut fixture.** The unit tests check the conversion against an
  independent floating-point reference across the colour cube, which covers
  the arithmetic; what is untested is a real saturated photograph end to end.
- Video hosting remains a future, separately scoped capability.
