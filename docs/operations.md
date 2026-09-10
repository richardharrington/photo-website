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

**Email notifications, turned on by 2026-09-10.** All five of the Worker's
notification secrets are set (`wrangler secret list` shows `NOTIFY_FROM`,
`DISPLAY_SITE_URL`, `CLOUDFLARE_ACCOUNT_ID`,
`CLOUDFLARE_ADDRESSES_READ_TOKEN` and `SITE_TITLE`), so the domain exists and
the digest runs on the nightly cron.
[Adding email notifications](#adding-email-notifications) stays written as a
procedure because it is worth re-reading after any change to the domain, the
tokens, or the recipient list.

**Email submissions, 2026-09-09. Shipped and deployed, not yet turned on.**
The Worker carrying the `email()` handler is live, but `SUBMIT_ADDRESS` is not
among its secrets, so the handler accepts nothing at all — unconfigured means
inert, exactly as it does for the digest. Three things remain, and none of
them is a code change: the Email Routing rule for the submission address, the
secret itself, and widening the bucket's CORS policy.
[Adding email submissions](#adding-email-submissions) is the whole procedure.

Both of these say what was true when they were written. `npx wrangler secret
list` names the secrets actually set, and `npx wrangler deployments status`
says which version of the Worker is serving; neither prints a secret's value.

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

### 4a. Optional: email notifications

The daily digest needs a domain, and is independent of everything else here.
It has its own self-contained procedure —
[Adding email notifications](#adding-email-notifications) — which can be
followed at any point, before launch or years after it. Skip it and the rest
of this sequence is unchanged.

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
  (`config/build-env.ts`).

  `R2_ACCOUNT_ID` is the one value nothing reads *until* email notifications
  are turned on, at which point the admin function reads it as the Cloudflare
  account ID — the addresses live in the account that holds the bucket, so it
  is reused rather than duplicated under a second name. Set it here anyway;
  it costs nothing and it is one less thing to remember later.

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
      "AllowedMethods": ["PUT", "GET"],
      "AllowedHeaders": ["content-type", "range"],
      "MaxAgeSeconds": 3600
    }
  ]
  ```

  The browser uploads are `cors`-mode fetches, so a real `Origin` header is
  sent even under `Referrer-Policy: no-referrer` — this rule does work, unlike
  an origin check on image loads.

  It is deliberately narrower than most CORS advice. Only two requests in
  either app leave the site's origin, and this rule is exactly what they need
  and nothing more.

  `uploadArtifact` in `src/admin/upload/create.ts` sends one header,
  `content-type`, uses `PUT`, and reads only `response.ok`. A `PUT` carrying an
  image content type is never a simple request, so every upload is preceded by
  an `OPTIONS` preflight that R2 answers from this rule.

  The `GET` and the `range` header are for the **Inbox** alone: the admin
  browser reads an emailed original back out of `inbox/` through a presigned
  GET, once as a `Range` request for the EXIF thumbnail and once in full on
  Add. Nothing else reads from the bucket — every other read goes through the
  Worker and the bucket stays private. **A signature does not cover `Range`**,
  so allowing it is a CORS question rather than a signing one, and getting it
  wrong looks like a network error with no status code (decisions.md #84).

  There is still **no `ExposeHeaders`** — not for `ETag`, which guides commonly
  add, and not for `Content-Range` either. Both Inbox reads take
  `response.ok` and then the body; neither reads a single response header, and
  a 206 body is readable without `Content-Range` being exposed. Add it if
  something ever needs to read it, and not before.

  Allowing `GET` here grants no new access to the bucket. CORS decides whether
  a browser will hand a response to script on a given origin; what may be read
  at all is still decided by the presigned URL, and the bucket remains private
  to anyone without one.

  If you are not using email submissions, `["PUT"]` and `["content-type"]`
  alone remain correct.

- [ ] Confirm the rule with a preflight. It is unauthenticated, so this needs
      no credentials:

  ```sh
  curl -si -X OPTIONS "https://<account-id>.r2.cloudflarestorage.com/<bucket>/probe" \
    -H "Origin: https://<your-site>.netlify.app" \
    -H "Access-Control-Request-Method: PUT" \
    -H "Access-Control-Request-Headers: content-type"
  ```

  Expect `204` with `Access-Control-Allow-Origin` echoing your origin rather
  than `*`, `Allow-Methods` naming `PUT`, `Allow-Headers: content-type`, and
  `Vary: Origin` — the last confirming R2 will not serve that allow to a
  different origin.

- [ ] With email submissions, probe the Inbox's read as well:

  ```sh
  curl -si -X OPTIONS "https://<account-id>.r2.cloudflarestorage.com/<bucket>/probe" \
    -H "Origin: https://<your-site>.netlify.app" \
    -H "Access-Control-Request-Method: GET" \
    -H "Access-Control-Request-Headers: range"
  ```

  Expect `204`, `Allow-Methods` naming `GET`, and `Allow-Headers` naming
  `range`. Without the last, every Inbox card shows neutral tiles and the
  browser console shows a failed fetch with no status code — a preflight
  rejection, which is not an HTTP error the page can see.

Uploads fail until this is in place, so it must precede the launch checklist's
end-to-end upload. A custom domain later is a second origin and has to be
added here, or uploads break from the new hostname while continuing to work
from the old one — see
[Moving the site to the domain](#moving-the-site-to-the-domain).

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

## Adding email notifications

Everything needed to turn the daily digest on, for a site that is already
deployed and working. Self-contained: nothing above is a prerequisite beyond
having the site running, `.env` present, and `wrangler` able to reach the
account. Follow it in order — the Worker must be able to send before the admin
page can ask it to.

Until this is done nothing sends, and nothing else is affected. The nightly
cron logs `Notifications are not configured; sending nothing.` beside its
usual maintenance line and carries on. The Emails page itself shows
`Something went wrong` until step 5 gives it a token — a missing environment
variable is a 500 here exactly as it is on every other admin route
(`requiredEnv`), so it is the expected face of "not set up yet" rather than a
fault. The library, the trash, and uploading are untouched either way.

**The one cost is a domain.** Buy it wherever you like — the registrar is
irrelevant to all of this. What Email Routing requires is that the domain's
**DNS is hosted at Cloudflare**, which is a free zone in the same account as
the bucket and a nameserver change at whatever registrar you used. Cloudflare
Registrar is worth a look only because it sells at cost and skips that step;
Namecheap or anyone else works identically.

The digest needs the domain only as a From address, so the site can stay on
`netlify.app` and `workers.dev` and nothing below assumes otherwise. Moving
the site onto the domain as well is a separate, optional, and much smaller job
than it sounds — see [Moving the site to the domain](#moving-the-site-to-the-domain).

### 1. A domain, with Email Routing

- [ ] Register a domain anywhere you like, or use one you already have.
- [ ] Add it to Cloudflare as a zone in **the same account as the R2 bucket**,
      and change the nameservers at your registrar to the two Cloudflare
      assigns. The free plan is enough.

      This delegation is the actual requirement — not where the domain was
      bought, and not transferring the registration. Cloudflare has to serve
      the DNS because Email Routing works by putting `MX` records there, and
      on the free plan that means full nameserver delegation rather than
      Cloudflare's partial CNAME setup. Propagation is usually minutes and
      Cloudflare emails you when the zone goes active.
- [ ] Confirm the zone shows as **Active** before continuing. Email Routing
      cannot be enabled on a pending one.
- [ ] Enable **Email Routing** on the zone. Cloudflare adds the MX and TXT
      records itself; accept them.
- [ ] Optionally add a routing rule forwarding `photos@<domain>` to your own
      inbox, so a reply to a digest is not silently lost. Note the
      consequence: the forwarding target then *is* a verified destination
      address in the account, and will therefore appear as a row on the
      Emails page. That is correct — every verified address in the
      account is a potential recipient (decisions.md #70) — but it is
      surprising the first time.

### 2. Two API tokens

Both restricted to this account only, and both scoped to Email Routing
Addresses and nothing else.

- [ ] One with **Email Routing Addresses Write** — for Netlify, which adds and
      removes addresses. It is stored as `CLOUDFLARE_ADDRESSES_WRITE_TOKEN`.
- [ ] One with **Email Routing Addresses Read** — for the Worker, which only
      ever asks whether an address is verified. It is stored as
      `CLOUDFLARE_ADDRESSES_READ_TOKEN`.

Two rather than one so the cron can never alter the recipient list, whatever
else goes wrong (decisions.md #70). Each variable is named for the permission
you tick when creating the token, which is the only check there is: **crossing
them fails silently in the dangerous direction.** Give Netlify the read-only
token and the Emails page throws a permission error the first time you
add an address — loud, and immediately obvious. Give the *Worker* the
write-capable one and nothing breaks at all: the digest sends, the test button
works, no error is logged, and the nightly cron quietly holds the power to
delete every recipient. Nothing in this system would ever tell you.

### 3. The Worker's five secrets

Take `$DISPLAY_PATH` from `.env` rather than typing it — it is the whole
access model, and a shell history is not the place for it.

```sh
set -a; . ./.env; set +a
SITE="https://<your-site>.netlify.app"

printf '%s' "photos@<your-domain>" | npx wrangler secret put NOTIFY_FROM
printf '%s' "$SITE/$DISPLAY_PATH"  | npx wrangler secret put DISPLAY_SITE_URL
printf '%s' "$R2_ACCOUNT_ID"       | npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
printf '%s' "$SITE_TITLE"          | npx wrangler secret put SITE_TITLE

# Prompted for rather than piped, so it stays out of shell history.
# Paste the *read-only* token.
npx wrangler secret put CLOUDFLARE_ADDRESSES_READ_TOKEN
```

- [ ] `SITE_TITLE` must be **the same value you set on Netlify**, or the mail
      and the website will call the site two different things. It is a secret
      rather than a committed `[vars]` entry in `wrangler.toml` only so that
      one installation's name stays out of a repository anyone can fork; there
      is nothing sensitive about it.

  **Upgrading from a Worker that already has `SITE_TITLE` as a `[vars]`
  entry?** Then this one command fails, and only this one:

  ```text
  ✘ [ERROR] Binding name 'SITE_TITLE' already in use. [code: 10053]
  ```

  A secret cannot take a name a plaintext var already holds. Run step 4's
  `npx wrangler deploy` **first** — `wrangler.toml` is the source of truth for
  `[vars]`, so deploying the current file drops `SITE_TITLE` from the var set
  and frees the name — then come back and set the secret. Nothing else in this
  section is order-sensitive, and a fresh installation never meets this at all.

  Between those two commands the Worker has no `SITE_TITLE`, so the digest
  logs `Notifications are not configured; sending nothing.` and skips. Harmless
  unless you leave it half-done past 04:17 UTC.
- [ ] All five set. `DISPLAY_SITE_URL` is the display site's base URL
      *including its secret path segment*; the digest links to
      `$DISPLAY_SITE_URL/recent`. Write it without a trailing slash — the
      Worker strips one, so it is harmless, but this value is what every
      recipient sees.
- [ ] `ASSET_SIGNING_KEY` is already set on the Worker from the original
      setup. It signs the test-send grant as well as the asset URLs, so
      nothing new is needed — but the test button returns a generic failure if
      it is somehow absent.

### 4. Deploy the Worker

- [ ] `npx wrangler deploy`. This is what registers the `[[send_email]]`
      binding declared in `wrangler.toml`; the secrets above are inert without
      it.

  No second deploy afterwards: `wrangler secret put` creates a new version of
  the Worker and deploys it itself, so a secret set at any point — before this
  step or long after it — is live the moment the command returns.

### 5. Netlify: one variable, then a deploy

- [ ] Set `CLOUDFLARE_ADDRESSES_WRITE_TOKEN` — the **write** token from step
      2. The Worker's is a different token under a different name
      (`..._READ_TOKEN`), so if you find yourself pasting the same value
      twice, something has gone wrong.
- [ ] Confirm `R2_ACCOUNT_ID` is set. Nothing read it before this feature; the
      admin function reads it now as the Cloudflare account ID. Without it
      every request to the Emails page is a 500.
- [ ] Deploy. An environment-variable change alone does not rebuild the site,
      and the notification code has to ship anyway, so push to `master` or
      trigger a deploy by hand.

### 6. Prove it end to end

- [ ] Open the admin site's **Emails** page (`/emails` under the admin path).
      It should list any destination addresses the account already has —
      including a forwarding target from step 1, if one was added.
- [ ] Add your own address. Cloudflare emails it a confirmation link; the row
      shows **Awaiting verification** until you click it.
- [ ] Click the link, reload the page, and confirm the row now reads
      **Verified**.
- [ ] Press **Send test** and read what arrives. Expect
      `[Test] No new photos on Family Photos` — the address was switched on
      just now, so its clock starts now and the library that was already there
      is not new to it (decisions.md #71). Check the link in it opens the
      Recently added view.

  This is the only way to confirm the domain, the binding, the five secrets,
  the token, and the link are all right without waiting for 04:17 UTC — and
  without the family receiving the experiment (decisions.md #73).

  If the row says the mail Worker did not answer in time, **check the inbox
  before pressing it again**. The admin function has to give up before
  Netlify's ten-second limit does, and the send is the slow part of the round
  trip, so a slow destination can time the page out on a message that was
  delivered. The email arriving is the authoritative result; the row is a
  convenience.

- [ ] Optionally watch the next cron run with `npx wrangler tail` and look for
      the `Digest complete` line beside `Maintenance complete`.

### Then, for real recipients

- [ ] Add each family member's address. Each gets one confirmation email from
      Cloudflare and must click it once; nothing is sent to them until they
      do, and the page says so.
- [ ] Tell them the message is a count and a link, that it arrives at most
      once a day and only when something has been added, and that there is no
      unsubscribe link because there is deliberately no unauthenticated write
      path on this site — they ask you, and you remove the address
      (decisions.md #74).

## Adding email submissions

Lets a family member the administrator has switched on **email photographs to
the site**. They wait in the admin app's Inbox until an administrator has
looked at them; nothing is published by sending it.

Everything this needs already exists after
[Adding email notifications](#adding-email-notifications): the domain, Email
Routing, the send binding, the destination-address list, and the Worker. This
adds one routing rule, one Worker secret, and two lines to the bucket's CORS
policy. Nothing new is bought or subscribed to.

### 1. A routing rule for the submission address

- [ ] **Cloudflare → Email → Email Routing → Routing rules → Create address.**
      Custom address `submit`, action **Send to a Worker**, destination
      `photo-assets`.

  Pick a local part that is not guessable-adjacent to anything else if you
  like, but it is not a secret: the two proofs are what protect this, not the
  address (decisions.md #80). The digest's `photos@` address stays send-only
  and gets no rule — mail to it is not read, and now there is somewhere else to
  send photographs.

- [ ] A **catch-all** rule, if the account has one, must not point at this
      Worker. The handler compares the recipient against `SUBMIT_ADDRESS` and
      drops anything else, so a catch-all cannot feed it by accident — but a
      catch-all sending every stray message to a Worker is worth not having.

### 2. The Worker's sixth secret

```sh
printf '%s' "submit@<your-domain>" | npx wrangler secret put SUBMIT_ADDRESS
```

- [ ] The **full address**, not the local part. It is compared against the
      message's recipient after lowercasing.
- [ ] Without it the handler accepts nothing at all — the same
      "unconfigured means inert" posture the digest has. That is also the way
      to switch the feature off: delete the secret, and mail to the address is
      silently dropped.
- [ ] No new Netlify variable. The admin function already holds the S3
      credentials that presign uploads, and presigning a read uses the same
      client.

### 3. Deploy, and widen the bucket's CORS

- [ ] `npx wrangler deploy`, unless the running Worker already carries the
      `email()` handler — `npx wrangler deployments status` gives the live
      version's timestamp to compare against. The handler ships with the
      Worker, and the routing rule has nothing to deliver to until it does.

  **Setting the secret in step 2 needs no deploy of its own.**
  `wrangler secret put` creates a new version of the Worker and deploys it
  itself, so a secret set at any point — before this step or long after it —
  is live the moment the command returns.
- [ ] Extend the bucket's CORS policy: add `"GET"` to `AllowedMethods` and
      `"range"` to `AllowedHeaders`, in the rule that already names your
      origins. Two words, nothing else — see
      [Cloudflare: bucket CORS](#7-cloudflare-bucket-cors) for the full rule
      and a probe for it. **Do this before the first submission**, or the
      Inbox loads with every tile blank and no error worth reading.

### 4. Switch a sender on

- [ ] On the admin site's **Emails** page, find a **verified** address and turn
      **Can submit** on. The switch is inert until Cloudflare has the
      confirmation, which is the same rule the digest has and for the same
      reason.
- [ ] Turn **Reviews inbox** on for your own address. Your daily email then
      says how much is waiting, and arrives even on a day when nothing new was
      added — which is the point, since otherwise a quiet week is exactly when
      you would not hear.

### 5. Prove it end to end

- [ ] From that address, email one photograph to the submission address with a
      real subject line. Expect a plain-text receipt within a minute or two:
      *"1 photo from your message … arrived and will appear on … once they have
      been looked at."*
- [ ] Open the admin site's **Inbox**. Expect one card naming the sender, the
      subject as sent, the caption it proposes, and one ticked row. A JPEG
      shows its embedded thumbnail; **a HEIC shows a neutral tile with its
      filename and size, and that is correct** — a HEIC has no EXIF thumbnail
      (decisions.md #84).
- [ ] Press **Show** on that row. It decodes the photograph here in the
      browser and the tile becomes the picture, upright. That decode is the
      slow half of adding a photograph, which is why it waits to be asked and
      runs one file at a time; a card with several hidden photographs offers
      **Show all**, and they still decode in turn.
- [ ] Correct the caption and press **Add**. The photograph goes through the
      same pipeline a dropped file does, in this browser, and appears in
      Recently added. The Inbox count returns to zero.
- [ ] Send a second message from an address that is **not** switched on. Expect
      **nothing at all** — no bounce, no receipt, no card. That silence is the
      design (decisions.md #80); confirm it in `npx wrangler tail`, which logs
      the drop with the sender's domain and never their address.

- [ ] **If the first message never arrives, read the log before anything
      else.** Watch `npx wrangler tail` and send again. A line like

      ```text
      Submission dropped {"reason":"not-authenticated",
        "detail":"foreign-authserv","sawAuthservId":"…","fromDomain":"…"}
      ```

      means the one value in this feature that was never verified against a
      real message is wrong: `CLOUDFLARE_AUTHSERV_ID` in
      `src/shared/email-auth.ts`. Cloudflare does not document the identity it
      stamps its `Authentication-Results` header with, so that constant is an
      expectation, and it is checked strictly because a header written under
      somebody else's identity is somebody else's claim. Set it to whatever
      `sawAuthservId` printed, deploy, and send again.

      While it is wrong the feature fails closed: every submission is dropped
      and no sender is told, which is the right direction to be wrong in and
      also indistinguishable from nobody having sent anything. Hence this step.

- [ ] **Capture the real header into the test fixture** while you are here. Add
      one line to `handleSubmission` to log
      `authenticationResultsHeaders(message.headers)[0]`, send a message from
      each provider your family actually uses, and paste what arrives into
      `CLOUDFLARE_GMAIL` in `tests/unit/email-auth.test.ts` — one fixture per
      provider is better than one. The parser is a pure function of that
      string, so the fixture *is* the test, and until it holds a real capture
      what it pins is the RFC 8601 grammar rather than what Cloudflare emits.
      Remove the log line afterwards: a full `Authentication-Results` header
      names the sender's domain and their signing selector.
- [ ] Send a message with a PDF and no image. Expect an ordinary
      delivery-failure message saying no photos were found.

### What to tell a sender

- The subject line becomes the caption, and every photograph in one message
  gets the same one.
- JPEG, PNG and HEIC only. Anything else in the message is ignored.
- Nothing appears on the site until somebody has looked at it.
- Send from the address that was switched on. A forward from another mailbox
  will not arrive.

### Retention, and what it costs

Submissions are deleted **30 days** after they arrive, reviewed or not, by the
same daily pass that purges the trash. An administrator away for a month loses
them, and the sender is not told. That is deliberate: these are originals as
sent, GPS and all, and the site should not hold one indefinitely because nobody
got round to it (decisions.md #79). The Worker also bounces new mail once the
inbox holds more than 200 parts or 2 GB.

## Moving the site to the domain

Optional, and independent of the digest — the digest only needs the domain as
a From address. Worth reading before assuming it is a big job: **no code
changes at all**, a handful of configuration edits, and an hour of which most
is waiting on DNS and a certificate.

The reason there is no code to change: `contentSecurityPolicy`
(`src/shared/headers.ts`) builds every directive from `'self'` plus two
env-derived origins — the Worker's, from `WORKER_BASE_URL`, and R2's, from
`R2_S3_ENDPOINT`. Neither of those moves, and `'self'` is whatever origin
served the document, so the policy follows the site on its own. Nothing in the
codebase hardcodes a hostname, both apps fetch relative paths, and the three
build-time defines (`config/build-env.ts`) are the app base path, the Worker
URL, and the site title — none of them the site's own origin.

### Which name: apex or subdomain

A free choice; both work and both are one DNS record. Take the apex
(`<domain>`, no prefix) unless you have a reason not to — it gives the shorter
URL, and the display URL is already long because the secret path is. That URL
gets read aloud and pasted by family members, so the saving is worth something
real.

The reason this needs saying at all is that classic DNS forbids it. A `CNAME`
must be the *only* record for its name, and enabling Email Routing puts `MX`
and `TXT` (SPF) records on the apex — so a strict provider would refuse a
`CNAME` there, which is why sites have historically lived on `www.` or a
subdomain. **Cloudflare removed that constraint with CNAME flattening**: it
accepts the `CNAME` at the apex, resolves it itself, and hands out `A` records
to whoever asks. It is on by default ("Flatten CNAME at root") and invisible
in the interface. Nothing about it is fragile, and this is a very well-trodden
configuration.

Mail and web do not otherwise interact. A browser asks for `A`, a mail server
asks for `MX`; they answer different questions and share a name without
colliding. Adding a web record cannot break Email Routing.

The case for a subdomain (`photos.<domain>`) is tidiness alone: the apex would
hold the mail identity and the subdomain the site, with no name doing two
jobs. If that appeals, take it — nothing else in this document assumes either
choice.

### Leave the record unproxied

**Grey cloud, not orange.** This one is not a free choice, and it matters more
than the name. Cloudflare's proxy is optional per record; three reasons to
leave it off here:

- Netlify issues the certificate through Let's Encrypt, which validates by
  fetching a file over HTTP from the name being certified. With Cloudflare
  proxying, that request is answered by Cloudflare rather than Netlify and the
  issuance can fail.
- Netlify already is a CDN. A second one in front caches the same assets a
  second time and adds a hop.
- Proxied, every request URL passes through Cloudflare's edge — which means
  the secret display path would appear in Cloudflare's logs for the first
  time. Cloudflare already holds the photographs, but the path *is* the access
  model (design.md, "Access and privacy model"), and there is no reason to
  hand over the capability as well as the contents.

### The changes

Written with the apex as the example; substitute `photos.<domain>` throughout
if you chose the subdomain. Nothing below differs between the two beyond the
name itself.

- [ ] **Netlify: add the custom domain.** Site settings → Domain management →
      add `<domain>`. Netlify shows the DNS record it wants.
- [ ] **Cloudflare: create that record, unproxied.** DNS → Records → add what
      Netlify asked for, at `@` for the apex, and click the orange cloud so it
      turns grey (**DNS only**). A `CNAME` at `@` alongside the existing `MX`
      records is fine here; CNAME flattening is what makes it so. Then wait
      for Netlify to report the certificate as issued; minutes, usually.
- [ ] **Confirm mail still works.** Send a message to `photos@<domain>` — or
      just check that the `MX` and `TXT` records are still listed after adding
      the web record. They should be untouched; this is a thirty-second check
      against having fat-fingered the wrong row.
- [ ] **R2: add the new origin to the bucket's CORS rule** (step 7's JSON).
      List *both* origins while the move settles:

  ```json
  "AllowedOrigins": [
    "https://<your-site>.netlify.app",
    "https://<domain>"
  ]
  ```

  This is the one change that breaks something if forgotten: uploads are the
  only cross-origin request either app makes, so the admin would load fine on
  the new hostname and fail on the first file. Re-run step 7's `curl`
  preflight against the new origin to confirm.

- [ ] **Worker: repoint `DISPLAY_SITE_URL`**, so digest links go to the new
      host rather than the old one:

  ```sh
  set -a; . ./.env; set +a
  printf '%s' "https://<domain>/$DISPLAY_PATH" \
    | npx wrangler secret put DISPLAY_SITE_URL
  ```

  No `wrangler deploy` is needed — a secret takes effect on its own.

### Afterwards

- [ ] Send yourself a test from the Emails page and check the link in
      it points at the new host.
- [ ] Give the family the new display URL. The old one keeps working: Netlify
      301s `<your-site>.netlify.app` to the primary domain preserving the
      path, and `Referrer-Policy: no-referrer` means the redirect leaks
      nothing on the way.
- [ ] Walk the [launch checklist](#launch-checklist) against the new hostname.
      Most of it is origin-independent, but it is the cheapest way to confirm
      the gate, the 404s, and an end-to-end upload all still behave.

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
snapshots, the audit log, and `catalog/notifications.json`.

That last one needs mention rather than ceremony. Losing it costs at most one
digest: who exists and who has verified lives at Cloudflare, not here, so the
recipients are all still there — every one of them simply reads as switched
off until the administrator switches them on again, which restarts their
clocks.

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

`catalog/notifications.json` is restored the same way — a conditional write
against its current ETag — but it is not on the critical path and there is no
snapshot history for it. If it is gone, do not reconstruct it: switch each
recipient back on from the Emails page and accept that their clocks
start again.

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

- [ ] **The same run logs the digest pass.** Beside `Maintenance complete`
      there is a `Digest complete` line with `considered`, `sent`,
      `skippedUnverified`, `skippedDisabled`, `skippedEmpty`, and `failed` —
      or, on a deployment without the five secrets,
      `Notifications are not configured; sending nothing.` Both are
      acceptable; silence is not. Watch it with `npx wrangler tail`.

- [ ] **The maintenance line accounts for the inbox too.** Its
      `purgedSubmissionIds` is the emailed submissions whose 30 days have
      elapsed — empty on a healthy week. It is the *only* thing that deletes
      from `inbox/` unattended; `orphanKeysDeleted` covers `photos/` alone and
      must never grow to include the inbox (decisions.md #85).

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
