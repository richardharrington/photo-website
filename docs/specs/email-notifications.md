# Email notification of new photos

Spec, 2026-09-05. A separate agent implements this. The decisions below are
settled unless marked "implementer's discretion". Where this spec and the code
disagree, the spec wins; where it and `docs/design.md` disagree, the spec wins
and the doc is updated (section 15).

## 1. Outcome

A family member who asks for it receives one plain-text email a day saying how
many photographs were added since their last email, with a link to the
Recently added view. Nothing else: no thumbnails, no per-photo text, no
replies.

The administrator manages who receives it from a new **Notifications** page in
the admin app: add an address, remove one, switch an address's notifications
on or off, see whether the recipient has verified, see when they were last
sent a digest, and send themselves a test.

It costs nothing to run beyond a domain name. No service that harvests data is
involved; the only party that ever sees a recipient address is Cloudflare,
which already holds the photographs.

## 2. The sender, and why

Cloudflare Email Service, from the existing Cloudflare Worker, using the
`send_email` binding.

- Sends to **verified destination addresses** in the Cloudflare account are
  free and unlimited on the Workers Free plan, and are not counted against any
  quota. Sending to an *arbitrary* address needs the paid plan; this feature
  never does that.
- A verified destination address is one whose owner has clicked a
  confirmation link Cloudflare emailed them, once. This is Cloudflare's rule.
  The original wish for "no verification" bends here by one click per
  recipient; the trade was accepted.
- The From address must be on a domain whose DNS is at Cloudflare with Email
  Routing enabled. The site has no domain today, so one is bought (Cloudflare
  Registrar sells at cost). The domain is used **only** for this. The site
  itself stays on `netlify.app` and `workers.dev`; moving it is out of scope.

Rejected, with the reason, for `decisions.md`:

- Proton: SMTP submission needs a paid plan plus a custom domain; the
  administrator has a free plan. Proton Bridge needs a resident machine.
- A personal mailbox over SMTP (iCloud and the like): puts a credential that
  sends as the administrator into a cron job, and the administrator did not
  want that.
- Brevo, Mailtrap, SMTP2GO, Resend: a third company holds the recipient list,
  and the marketing-oriented ones add open-tracking pixels. Resend needs a
  domain anyway, at which point Cloudflare dominates it.
- Netlify: has no email sending.

## 3. Two sources of truth

**Which addresses exist, and whether each is verified: Cloudflare.** The
account's destination-address list *is* the recipient list. Nothing about
addresses is stored anywhere else. Adding an address through the admin page
calls Cloudflare's API, which sends the verification email; removing one
deletes it there. Because the list is account-wide, every verified address in
the account is a potential recipient, and the account's Email Routing is used
for nothing else.

The API:

|        |                                                                 |
| ------ | --------------------------------------------------------------- |
| List   | `GET /accounts/{account_id}/email/routing/addresses`            |
| Create | `POST /accounts/{account_id}/email/routing/addresses` `{email}` |
| Delete | `DELETE /accounts/{account_id}/email/routing/addresses/{id}`    |

Each address is `{ id, email, created, modified, verified }`, where `verified`
is an ISO instant or `null`. `per_page` tops out at 50; page until the
response is short (the list will never reach 50, but the loop is three lines).

Permissions: "Email Routing Addresses Write" for the Netlify token, "Email
Routing Addresses Read" for the Worker token (section 9).

**Per-address state that Cloudflare cannot hold: R2.** One object,
`catalog/notifications.json`, under `R2_KEYS.notifications`:

```ts
interface NotificationState {
  schemaVersion: 1;
  recipients: Record<
    string, // the address, lowercased
    {
      /** Whether the nightly digest goes to this address. */
      enabled: boolean;
      /**
       * The upload instant this address has been told about: the newest
       * `createdAt` covered by its last digest, or the instant it was
       * enabled. Photos with `createdAt` strictly greater are "new" to it.
       */
      seenThrough: string;
      /** The last digest actually sent, for the admin page. */
      lastSent: { at: string; count: number } | null;
    }
  >;
}
```

Written only through the store seam with `putConditional` — `ifAbsent` to
create, `ifMatch` thereafter — with reload-and-retry on conflict, exactly as
`mutateCatalog` does. A new `src/shared/notifications-repository.ts` holds
`loadNotificationState` and `mutateNotificationState`; it may share helpers
with `catalog-repository.ts` but must not put this state inside the catalog:
every viewer request loads the catalog through the Worker, and it should not
carry this.

Keying by address rather than Cloudflare's `id` is deliberate: an address
deleted and re-added gets a new `id`, and the state for it should not
survive that anyway (section 7).

## 4. The digest rule

Run for each address that is **verified in Cloudflare and enabled in R2**.
For that address, with `L = livePhotos(catalog)`:

```
new(a) = { p ∈ L : p.createdAt > a.seenThrough }
```

- `createdAt` is the upload instant, an ISO string; string comparison is
  correct for ISO instants and avoids `Date` entirely.
- Live only. A photo uploaded and trashed before the digest is not counted,
  so the count matches what the link will show.
- If `new(a)` is empty, nothing is sent and nothing is written for `a`.
- Otherwise one email is sent to `a` alone (never several recipients on one
  message), and on success `a.seenThrough` becomes the greatest `createdAt`
  in `new(a)` — not "now", so a photo committed during the run is not skipped
  — and `a.lastSent` becomes `{ at: now, count: |new(a)| }`.
- A failed send for `a` leaves `a` untouched; tomorrow's digest for `a`
  covers both days. Other recipients are unaffected. Each is its own
  watermark; there is no global one.

**Enabling starts the clock.** When an address is added (section 7) or
switched from off to on, `seenThrough` is set to now. Turning an address off
and on again never backfills. The first run after deployment therefore
announces nothing about the existing library: every entry is created at
add-time with `seenThrough = now`.

This rule is a pure function in `src/shared/notifications.ts`:

```ts
planDigests(
  catalog: Catalog,
  state: NotificationState,
  addresses: readonly DestinationAddress[],
  nowIso: string,
): DigestPlan[]  // { email, count, seenThrough } per address to send
```

and the state update is another pure function applied per successful send.
Only the Worker executor touches storage and the binding.

## 5. The email

Plain text only. No HTML part, no images, nothing that could track.

From: `${SITE_TITLE} <${NOTIFY_FROM}>`. `SITE_TITLE` is a committed
`[vars]` entry in `wrangler.toml` (the value is already public in
`src/display/index.html`); `NOTIFY_FROM` is a Worker secret holding the bare
address, `photos@<domain>`, so the domain never appears in the repository.

Subject and body, with `N` the count and `T` the site title:

```
Subject: 3 new photos on Family Photos      (N ≥ 2)
Subject: 1 new photo on Family Photos       (N = 1)

3 new photos were added to Family Photos since your last update.

See them here:
https://<site>/<display-path>/recent

This is a daily update from Family Photos. To stop receiving it, ask
whoever runs the site.
```

The link is `${DISPLAY_SITE_URL}/recent`, where `DISPLAY_SITE_URL` is a
Worker secret holding the display site's full URL including the secret path
segment, no trailing slash. It carries the capability path, which the
recipient already has; the decision to include it was explicit.

There is no unsubscribe link: an unsubscribe endpoint would be a new
unauthenticated write path. The footer says what to do instead.

Exact singular/plural handling is required; exact footer wording is
implementer's discretion.

## 6. When it runs

Piggybacked on the existing cron, `17 4 * * *` UTC, in `scheduled()`:

1. `runMaintenance` as today.
2. Then the digest pass.

The two are isolated: a throw in either is caught and logged, and the other
still runs. Maintenance goes first because it can purge photos, and the
count should describe the library as it is after the purge.

The digest pass logs one JSON line per run — recipients considered, sent,
skipped as unverified or disabled or empty, failed — beside the existing
"Maintenance complete" line. Cloudflare's invocation logs are already enabled
in `wrangler.toml`. The state file's `lastSent` is the durable record.

The Worker is on the Free plan; the pass is a handful of fetches and one
small JSON write, well inside its limits. Cloudflare's cron does not retry a
failed run; per-address watermarks make that harmless.

## 7. The admin API

New routes in `netlify/functions/admin.ts`, behind `checkAccess` like every
other. The function today only accepts GET and POST, so removal is a POST,
not a DELETE.

| Route                              | Does                                                                                                                                                                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /notifications`               | Lists Cloudflare's addresses merged with the state file. Response: `{ recipients: [{ id, email, verified: boolean, enabled, lastSent }] }`, sorted by address.                                                        |
| `POST /notifications/add`          | `{ email }`. Creates the Cloudflare address (Cloudflare sends the verify email), then creates the state entry `{ enabled: true, seenThrough: now, lastSent: null }`. Returns the new row.                             |
| `POST /notifications/remove`       | `{ id }`. Deletes the Cloudflare address, then removes the state entry for its email. Returns `{ removed: email }`.                                                                                                   |
| `POST /notifications/set-enabled`  | `{ email, enabled }`. Flips the flag; when going off→on also sets `seenThrough = now`. Returns the row.                                                                                                              |
| `POST /notifications/test`         | `{ email }`. Signs a test grant and POSTs it to the Worker (section 8). Returns the Worker's `{ count }`, or 502-shaped failure as a plain `serverError()`.                                                           |

Order of the two writes in `add` and `remove` is Cloudflare first, then R2:
if the second write fails the state is at worst missing an entry, and
`GET /notifications` treats a verified address with no state entry as
`{ enabled: false, lastSent: null }` and displays it, so nothing is hidden.
The cron treats a missing entry the same way (disabled). A state entry whose
address is no longer in Cloudflare is invisible to both, and is pruned on the
next mutation of the state file. Implementer's discretion on whether `GET`
also prunes.

Validation: `email` must parse as one address with a single `@` and no
whitespace, lowercased before use; anything else is `badRequest`. Cloudflare
does its own checking and its refusal is surfaced as `badRequest` with its
message.

Environment for the function: `CLOUDFLARE_ACCOUNT_ID` (the same account as
R2; `R2_ACCOUNT_ID` already exists and is read by nothing — reuse it under
its existing name rather than adding a second) and
`CLOUDFLARE_EMAIL_API_TOKEN` (read+write). Both go in `.env.example` with a
comment; the token is a secret.

The Cloudflare client is a small module in `src/shared/` taking a `fetch`
function and the account ID, so both runtimes share it and it stays free of
runtime globals. `fetch` is passed in, not read from the global.

## 8. The test button

A per-address "Send test" that sends **tonight's digest for that address,
computed now, marked as a test, without touching the watermark**. If the
count is zero it still sends, saying so. It exists so the administrator can
enable their own address, press the button, and see exactly what a recipient
would see, without waiting for 04:17 UTC and without the family getting an
early digest.

Subjects for the test:

```
[Test] 3 new photos on Family Photos
[Test] No new photos on Family Photos
```

The body is the normal body, or for zero: "No new photos have been added to
Family Photos since your last update.", then the link and footer as usual.

Only the Worker can send, and the Worker has no admin authentication, so the
admin function asks it with a signed request:

- `src/shared/signing.ts` gains a third grant, beside `AssetGrant` and
  `ConfirmationGrant`: `NotificationTestGrant { email, expiresAt }` with
  payload `notify-test:v1:${expiresAt}:${email}`, `signNotificationTest`
  and `verifyNotificationTest`, HMAC with `ASSET_SIGNING_KEY`, same
  `timingSafeEqualHex`. Lifetime 60 seconds.
- The admin function `POST`s `{ email, exp, sig }` as JSON to
  `${WORKER_BASE_URL}/notify/test`.
- The Worker's `fetch` today returns 404 for anything but GET and HEAD. It
  gains exactly one POST route, `/notify/test`, matched before that check.
  A bad signature, an expired one, an address not verified in Cloudflare, or
  any malformed body is the usual `notFound()` — never a distinguishable
  response. Success is `200 { count }`.
- The Worker does not consult `enabled` for a test: the point is to test
  before enabling. It does require `verified`, because Cloudflare will refuse
  otherwise and the failure would be opaque.

## 9. Worker configuration

`wrangler.toml` gains:

```toml
[[send_email]]
binding = "EMAIL"

[vars]
CATALOG_CACHE_SECONDS = "60"
SITE_TITLE = "Family Photos"
```

Secrets, all set with `wrangler secret put` and listed by name in
`.env.example`'s comments and in `operations.md`:

| Secret                       | Holds                                                        |
| ---------------------------- | ------------------------------------------------------------ |
| `NOTIFY_FROM`                | `photos@<domain>`                                            |
| `DISPLAY_SITE_URL`           | `https://<site>.netlify.app/<display-path>`, no trailing `/` |
| `CLOUDFLARE_ACCOUNT_ID`      | Account ID (kept out of the repo like the rest)              |
| `CLOUDFLARE_EMAIL_API_TOKEN` | Read-only "Email Routing Addresses Read" token               |

`Env` in `worker/src/index.ts` grows accordingly; `EMAIL: SendEmail` from
`@cloudflare/workers-types`, which is already a dependency and already
declares `SendEmail.send()`. If any of the four secrets is unset the digest
pass logs one line and does nothing; it must not throw into maintenance.

Two tokens rather than one: the cron can then never alter the list. Both
are scoped to the single account and to Email Routing Addresses only.

## 10. The admin page

A new top-level admin page, `notifications`, added to `ADMIN_PAGES` beside
`trash`, at `/<admin-path>/notifications`, with a link beside the Trash link
wherever that appears. Component: `src/admin/components/NotificationsPage.tsx`.

The page is a table, one row per address, sorted by address:

| Column         | Shows                                                                                  |
| -------------- | -------------------------------------------------------------------------------------- |
| Address        | The email.                                                                             |
| Status         | "Verified" or "Awaiting verification" (a badge, same visual weight as the unseen notice). |
| Notifications  | A switch, on/off. Disabled with an explanatory title while unverified — the flag can be set, but nothing sends until they verify. |
| Last sent      | `lastSent.at` as a local date-time and `lastSent.count` as "3 photos"; "Never" if null. |
| Actions        | "Send test" (disabled while unverified); "Remove".                                     |

Above the table: one input and an "Add" button. On success the row appears
with "Awaiting verification" and a short note: "Cloudflare has emailed
them a link to confirm. Nothing is sent until they click it."

"Remove" asks for confirmation naming the address. The existing `Confirm`
component takes a `PreviewResult` and counts IDs; either generalize it or
write a small sibling — implementer's discretion, but the confirm must name
the address and the button must say "Remove".

"Send test" shows an inline result on the row: "Sent: 3 new photos" or
"Sent: no new photos", or the error. It never navigates.

Every action calls the API and then refetches `GET /notifications` rather
than patching local state; the list is tiny and the truth is remote.
`useResource` as the other pages use it.

Nothing on this page reaches the viewer bundle: it is under `src/admin/`,
and `notifications` is admin vocabulary passed to `parseRoute` only by the
admin.

## 11. The local fake

`config/fixture-server.ts` mounts the admin routes of section 7 over an
in-memory fake of the Cloudflare address list and the existing
`InMemoryObjectStore` for the state file, and a fake `/notify/test` that
records what would have been sent and returns `{ count }`. Nothing sends
mail locally.

The fake needs both verification states reachable from a test.
Implementer's discretion on the mechanism; the suggestion is that the fake
marks an address verified immediately unless its local part begins with
`pending`, which is enough for Playwright and obvious in a test file.

Remember the fixture's admin handler is more permissive than production
(CLAUDE.md): add every route to the real function first.

## 12. Traps in the code

- **`worker/src/index.ts` refuses every non-GET.** The new POST route must be
  matched before that line, and only that one path.
- **`src/shared/` outside `ui/` must stay free of runtime globals.** The
  Cloudflare client takes `fetch` as an argument. `Date` is fine for
  `seenThrough` and `lastSent.at` — they are genuine instants, not capture
  times — but prefer the ISO strings as strings and compare them as strings.
- **Three tsconfigs compile `src/shared/`.** The new modules must typecheck
  under `tsconfig.worker.json` (no DOM lib) and `tsconfig.functions.json`.
- **The store seam.** The state file's writes go through `putConditional`
  and the `ConditionalWriteResult` union. No bare try/catch around it, and
  both conflict shapes tested against `fixtures/in-memory-store.ts`.
- **Cloudflare's `verified` is a timestamp or `null`**, not a boolean. Map it
  at the client boundary; nothing above sees the raw shape.
- **Address case.** Cloudflare returns what was typed. Lowercase at the
  boundary before it becomes a state key or a comparison.
- **Two writes, two systems.** Cloudflare first, then R2 (section 7). Never
  the other order.
- **`resetCatalogCache()`** after maintenance stays where it is; the digest
  pass reads the catalog fresh through `loadCatalog` and does not touch the
  cache.
- **Maintenance and digest must not share a failure.** Wrap each.
- **The Netlify function's 10-second limit.** `add` does two network writes;
  `test` waits on the Worker, which waits on Cloudflare's API and the send.
  Give the Worker fetch a 5-second `AbortSignal.timeout` so a hung Worker
  returns an error rather than a Netlify timeout.

## 13. Tests

Unit (Vitest, Node):

- `planDigests`: verified+enabled only; empty set sends nothing; watermark
  advances to the greatest `createdAt` in the set, not to now; trashed
  excluded; missing state entry means disabled; string comparison of
  instants; singular/plural subjects.
- `notifications-repository`: create with `ifAbsent`, update with `ifMatch`,
  both conflict shapes, reload-and-retry, pruning of entries with no address.
- `signing`: the test grant round-trips, rejects tampering and expiry.
- Worker `/notify/test`: 404 for bad signature, expired, unverified,
  non-POST, malformed body; 200 with count otherwise; watermark untouched.
  Run with a fake `SendEmail` and fake `fetch`.
- The digest executor with fake binding, fake `fetch`, and the in-memory
  store: one failed send leaves that recipient's entry alone and the others
  advance; a throw in the digest does not reach maintenance and vice versa.

Playwright (`tests/e2e/admin.spec.ts` or a new `notifications.spec.ts`,
chromium only is acceptable): add an address, see "Awaiting verification"
for a `pending…` one and "Verified" for another; toggle off and on; send a
test and see the inline result; remove with confirm; the page is a 404 under
the display path.

No test sends real mail. Nothing in `tests/` needs a domain, a token, or the
binding.

## 14. Operations

`docs/operations.md` gains a step after the Worker deploy, written with
variable references and never a real value:

1. Buy a domain (Cloudflare Registrar), or move one's DNS to Cloudflare.
   State plainly that this is the feature's only cost and that the domain is
   used for nothing else.
2. Enable Email Routing on the zone (Cloudflare adds the MX records).
   Optionally forward mail sent to `photos@<domain>` to the administrator's
   own inbox — but note that the forwarding target is then a verified
   destination address and therefore appears on the Notifications page.
3. Create the two API tokens with their exact permission names and the
   account restriction.
4. Set the four Worker secrets; set the two Netlify variables.
5. Deploy both targets — this is a `src/shared/` change, so both are needed,
   per CLAUDE.md.
6. Add the administrator's own address on the Notifications page, click the
   verification link, press "Send test", read the email.

Backup: `catalog/notifications.json` joins the backup and recovery sections.
Losing it costs one digest at most — every recipient's clock restarts when
the administrator re-enables them — so it needs mention, not ceremony.

Launch checklist, "Scheduled work": a line for the digest log line.

## 15. Documentation

- `docs/design.md`: a "Notifications" subsection under "Admin site" and a
  paragraph under "Access and privacy model" stating that the display URL
  travels by email to verified recipients by choice, and that the only party
  holding recipient addresses is Cloudflare.
- `docs/decisions.md`: a new dated section recording: why Cloudflare Email
  Service; why Cloudflare's list is the list; why per-recipient watermarks;
  why the test button exists despite adding a signed cross-runtime route; why
  no unsubscribe link; and section 2's rejected alternatives.
- `docs/implementation-plan.md`: the state file in "R2 object layout"; the
  new routes in "Read and write APIs"; the POST route in "Asset Worker".
- `.env.example`: the Netlify names, and a comment listing the Worker
  secrets.
- `README.md`: mention the Notifications page in whatever list of admin
  features exists.

## 16. Deliberately not decided

- Whether the site itself should move to the new domain. Out of scope; a
  second origin would also need a CORS change (operations.md notes this).
- Digest timing other than 04:17 UTC. Change the cron entry later if
  overnight arrival proves wrong; the watermark rule does not care.
- Any per-photo content in the email. The count and the link are the whole
  message until someone asks for more.
- Notification of anything other than uploads.

## Sources

- Cloudflare Email Service limits:
  https://developers.cloudflare.com/email-service/platform/limits/
- Cloudflare Email Service pricing:
  https://developers.cloudflare.com/email-service/platform/pricing/
- Cloudflare send bindings:
  https://developers.cloudflare.com/email-service/configuration/send-bindings/
- Cloudflare destination addresses:
  https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/
- Cloudflare address API:
  https://developers.cloudflare.com/api/resources/email_routing/subresources/addresses/methods/list/
- Proton SMTP submission: https://proton.me/support/smtp-submission
- Resend free tier: https://resend.com/blog/new-free-tier
- Netlify scheduled functions:
  https://docs.netlify.com/build/functions/scheduled-functions/
