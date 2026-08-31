# Handoff: Day-One Spike Results and Proposed Spec Amendments

**Date:** 2026-08-30
**Author:** implementation agent (spike execution)
**Audience:** the agent maintaining `design.md`, `implementation-plan.md`, and `decisions.md`
**Status:** both day-one spikes from `design.md` §Implementation validation are resolved.
Three defects were found. One design question remains open and needs an owner decision.

This document is self-contained: it assumes you have the three spec documents but
not the session that produced these results.

---

## 1. Executive summary

| # | Item | Outcome |
| --- | --- | --- |
| S1 | R2 conditional (ETag-guarded) writes | **Resolved** at documentation level. Feature exists on both surfaces. Live verification deferred — no Cloudflare account exists yet. |
| S2 | Browser WASM pipeline on real fixtures | **Resolved by measurement.** Works in Chromium and WebKit at acceptable speed, including 48.8 MP. |
| D1 | Double rotation of every portrait HEIC | **Defect found and fixed in the spike.** Would have shipped silently. |
| D2 | EXIF timestamps parsed in the wrong timezone | **Defect found.** Machine-dependent; corrupts day-grouping. |
| D3 | EXIF orientation returned as a string, not a number | **Defect found.** Silently disables rotation. |
| O1 | Display P3 → sRGB colour conversion | **Open.** Not implemented; deviation measured and small. Needs an explicit decision. |
| O2 | Firefox as an admin browser | **Owner decision taken:** unsupported for admin. |

The single most important result is **D1**. It produces artifacts that are
self-consistent and dimensionally plausible, so nothing in the current test plan
would have caught it. It was found only by rendering pixels and looking at them.

---

## 2. Spike 1 — R2 conditional writes

### 2.1 What was established

- **S3 API `PutObject` supports all four conditional headers** (`If-Match`,
  `If-None-Match`, `If-Modified-Since`, `If-Unmodified-Since`). A failed
  precondition returns **HTTP 412**.
- **Workers R2 binding** supports `put(key, value, { onlyIf: {...} })` with
  `etagMatches`, `etagDoesNotMatch`, `uploadedBefore`, `uploadedAfter`. On a
  failed precondition **`put()` returns `null` and does not throw.**
- **R2 is strongly consistent** for read-after-write and list-after-write.
  Bindings and the S3 API bypass cache entirely.
- Multipart uploads do **not** support conditional headers. Irrelevant here:
  `catalog/current.json` will never be multipart.

### 2.2 Why this matters to the design

The catalog design depends on read-modify-write with `If-Match`. That loop is
only correct because R2 guarantees a retry reads the write that just beat it.
**This rationale is currently absent from all three documents.** It should be
recorded, because a future migration to eventually-consistent storage would
silently break catalog atomicity.

The two surfaces fail in **structurally different ways** — 412 versus `null`.
Any shared retry helper must handle both shapes; a single `try/catch` is wrong
for the binding path, where a conflict is a normal return value.

### 2.3 Caveat that changes the test plan

[cloudflare/workers-sdk#6411](https://github.com/cloudflare/workers-sdk/issues/6411)
reports Miniflare's local R2 emulation **inverting** `onlyIf` logic
(`etagMatches: '*'` failing against an existing object; `etagDoesNotMatch: '*'`
succeeding against a missing one). Filed 2024-08-02, **closed as not planned**,
so it cannot be assumed fixed.

Consequence: `implementation-plan.md` §Testing says to unit-test "catalog
conflict retries" without naming a substrate. Testing that logic against
`wrangler dev`'s emulated R2 risks validating against backwards semantics.
Use an in-memory fake with explicitly asserted semantics, and verify real
behaviour once against a live bucket.

### 2.4 Not yet verified

Actual 412 behaviour under genuinely concurrent writers, against a real bucket.
This needs a Cloudflare account, which does not exist yet. The documented
fallback (routing all catalog mutations through a single Worker endpoint)
remains available. **Recommendation:** downgrade S1 from a blocking day-one
spike to a Phase 1 account-setup checklist item.

**Sources:** Cloudflare R2 docs — [S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/),
[Workers API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/),
[Consistency model](https://developers.cloudflare.com/r2/reference/consistency/).

---

## 3. Spike 2 — browser image pipeline

### 3.1 Method

A standalone Vite harness ran the full pipeline — fetch, SHA-256, EXIF extract,
decode, orient, flatten alpha, resize, encode — driven by Playwright, with
timings and output descriptors collected per fixture.

- Host: macOS (Darwin 25.5.0), Node v24.10.0
- `libheif-js@1.19.8` (WASM inlined into the JS bundle; **no separate `.wasm`
  fetch**, but still requires `'wasm-unsafe-eval'` in the CSP)
- `@jsquash/jpeg` (mozjpeg), `@jsquash/webp` (libwebp), `@jsquash/resize`, `exifr@7`
- Engines: Playwright **Chromium** and **WebKit**. Firefox tested then dropped (§5).

Note: Playwright's WebKit is not Safari proper. Results were consistent enough
with Chromium that engine-specific risk looks low, but one manual pass in real
Safari before launch is still advisable.

### 3.2 Fixtures

Four real photos supplied by the owner, plus four derived:

| fixture | device | coded | EXIF orient. | GPS | profile |
| --- | --- | --- | --- | --- | --- |
| `chef-with-trumpet.heic` | iPad Air (5th gen) | 4032×3024 | none | no | Display P3 |
| `childrens-show-theater.heic` | iPad Air (5th gen) | 4032×3024 | 1 | no | Display P3 |
| `classic-car.heic` | iPhone 12 Pro | 3024×4032 | **6** | **yes** (41.8434, 3.0662) | Display P3 |
| `old-safe-wall.heic` | iPhone 12 Pro | 3024×4032 | **6** | **yes** (41.9846, 2.8237) | Display P3 |
| `synthetic-48mp.heic` | derived (`sips` 2× upsample) | 6048×8064 (**48.77 MP**) | 6 | yes | Display P3 |
| `plain.jpg` | derived | 4032×3024 | — | no | — |
| `alpha.png` | synthetic RGBA, transparent corner | 800×600 | — | — | — |
| `malformed.heic` | first 5,000 bytes of a valid HEIC | — | — | — | — |

**Note for the spec:** the owner's actual devices are 12.2 MP (iPhone 12 Pro,
iPad Air 5). `design.md` justifies the 50 MP cap by reference to "48 MP
iPhones," which the owner does not currently have. The cap was still validated
against a true 48.77 MP file and is comfortable, so no change is required — but
the stated justification is hypothetical, not current.

### 3.3 Results (post-fix, end-to-end per photo)

| fixture | Chromium | WebKit |
| --- | --- | --- |
| `chef-with-trumpet.heic` (12.2 MP) | 5,148 ms | 4,375 ms |
| `childrens-show-theater.heic` (12.2 MP) | 4,081 ms | 4,102 ms |
| `classic-car.heic` (12.2 MP) | 4,841 ms | 4,782 ms |
| `old-safe-wall.heic` (12.2 MP) | 5,590 ms | 5,378 ms |
| **`synthetic-48mp.heic` (48.8 MP)** | **12,599 ms** | **12,309 ms** |
| `plain.jpg` (12.2 MP) | 4,131 ms | 3,924 ms |
| `alpha.png` (0.5 MP) | 324 ms | 296 ms |
| `malformed.heic` | clean rejection | clean rejection |

Stage breakdown, Chromium:

| stage | 12.2 MP | 48.8 MP |
| --- | --- | --- |
| libheif decode | 575 ms | 1,556 ms |
| orientation transform | 0 ms (n/a) | 352 ms |
| alpha flatten | 13 ms | 42 ms |
| **mozjpeg full-res q92 4:4:4** | **1,899 ms** | **7,065 ms** |
| resize 2560 / 1280 / 400 | 1,557 / 339 / 192 ms | 2,003 / 940 / 727 ms |
| webp 2560 / 1280 / 400 | 448 / 103 / 12 ms | 435 / 111 / 12 ms |

The full-resolution JPEG encode dominates. Decode is comparatively cheap.

### 3.4 Behaviours verified

- **Tiled-grid HEIC composited correctly.** Apple stores these as a `grid`
  derived item over 48 `hvc1` tiles. libheif returns the full composited image,
  not a single tile. This was the most likely silent-corruption path and it is
  ruled out.
- **GPS stripped.** Two fixtures carry real coordinates; no EXIF and no GPS is
  present in any output artifact. This satisfies the `design.md` privacy claim
  and was verified on real data, not a synthetic tag.
- **Alpha flattened on white.** 203,700 non-opaque pixels composited.
- **Malformed input rejected cleanly** in both engines — an ordinary error, no
  tab crash.
- **`chroma_subsample: 1` with `auto_subsample: false`** gives real 4:4:4
  control, confirming the premise of decision #2.

### 3.5 Storage

Four artifacts per photo:

| fixture | full.jpg | 2560 | 1280 | thumb | total |
| --- | --- | --- | --- | --- | --- |
| `chef-with-trumpet` | 2,062 KB | 310 KB | 102 KB | 17 KB | 2.43 MB |
| `childrens-show-theater` | 1,620 KB | 247 KB | 91 KB | 16 KB | 1.93 MB |
| `classic-car` | 1,958 KB | 440 KB | 134 KB | 17 KB | 2.47 MB |
| `old-safe-wall` | 3,029 KB | 824 KB | 272 KB | 32 KB | 4.06 MB |
| `synthetic-48mp` | 4,941 KB | 391 KB | 131 KB | 17 KB | 5.31 MB |

At ~300 photos/year averaging ~3 MB stored, that is **~0.9 GB/year** against
R2's 10 GB free tier. The free-tier assumption holds for several years.
Note the full-resolution JPEG is frequently **larger than the HEIC source**
(q92 4:4:4 versus HEVC); this is expected and worth stating so it is not later
mistaken for a bug.

---

## 4. Defects found

### D1 — Double rotation of every portrait HEIC (critical)

**Symptom.** Portrait iPhone photos were emitted **landscape**, in the
full-resolution download and all three WebP derivatives.

**Mechanism.** HEIF stores rotation in an `irot` item property. **libheif
applies `irot` itself during decode and returns already-upright pixels.** Apple
*additionally* writes a redundant EXIF `Orientation: 6`. Applying EXIF
orientation on top of libheif's output rotates a second time.

**Evidence.** `classic-car.heic` decodes to 3024×4032. Rendering libheif's raw
output shows a correctly upright portrait photo matching the publisher's own
thumbnail. Applying EXIF 6 yields 4032×3024, visibly rotated 90°.

**Why the current plan would not have caught it.** The four artifacts remain
mutually consistent and dimensionally plausible. `implementation-plan.md`
§Testing asserts "output dimensions" — and the *wrong* output has perfectly
self-consistent dimensions. Only pixel inspection distinguishes them.

**A methodological warning worth recording.** `sips -g pixelWidth/pixelHeight`
reports **displayed** dimensions (post-orientation) while `sips -s format jpeg`
**copies the orientation tag rather than baking rotation into pixels**. Using
`sips` as an orientation oracle produces a confidently wrong answer. It briefly
did here.

**Fix.** Orientation handling is decode-path dependent:

| decode path | EXIF orientation |
| --- | --- |
| HEIC via libheif | **do not apply** — `irot` already handled it |
| JPEG/PNG via `createImageBitmap({ imageOrientation: 'none' })` | **must apply** |

Always pass `imageOrientation: 'none'` explicitly on the bitmap path; the spec
default has shifted historically and differs across engines.

**Residual risk.** If a HEIC ever carries EXIF orientation but no `irot`, this
rule under-rotates. Not observed in any Apple fixture. A defensive
implementation could compare libheif's returned aspect against the
EXIF-implied display aspect and rotate only on mismatch.

**Test to add.** A portrait iPhone HEIC whose final artifacts are asserted to be
**portrait**, ideally by pixel comparison against a known-good rendering rather
than by dimensions alone.

### D2 — EXIF timestamps parsed in the wrong timezone

**Symptom.** `exifr` revives `DateTimeOriginal` into a `Date` by interpreting
the naive EXIF timestamp in **the parsing machine's local timezone**.

**Evidence.** `chef-with-trumpet.heic` has raw EXIF `2022:11:08 12:06:59` and
`OffsetTimeOriginal "+01:00"`. On this machine (UTC−5) exifr returned
`2022-11-08T17:06:59.000Z`. The same file parsed on a laptop in another zone
yields a different instant.

**Impact.** EXIF `DateTimeOriginal` is camera-local wall-clock time carrying no
zone. Day-grouping is the site's entire navigation structure; for photos taken
before roughly 08:00 local, this shifts the **calendar day** and files the photo
into the wrong day grid.

**Fix.** Parse with `reviveValues: false`, keep the naive `YYYY:MM:DD HH:MM:SS`
string, and store `OffsetTimeOriginal` separately. This is what `design.md`
already asks for — "camera-local calendar date/time is preserved… known offsets
are retained but timestamps are not shifted." The design is correct; the obvious
implementation of it is not.

### D3 — EXIF orientation returned as a string

**Symptom.** With `reviveValues: false` alone, exifr returns
`Orientation: "Rotate 90 CW"` rather than `6`. A numeric test such as
`orientation >= 5` is false for a string, so rotation is **silently skipped** —
on exactly the portrait photos it exists to correct.

**Fix.** `translateValues: false` as well. The two options must be set together:

```js
await exifr.parse(buf, {
  reviveValues: false,    // keep raw "YYYY:MM:DD HH:MM:SS" (D2)
  translateValues: false, // keep numeric enums, e.g. Orientation === 6 (D3)
  tiff: true, exif: true, gps: true, ifd0: true,
});
```

Verified to return `Orientation: 6` (number) and
`DateTimeOriginal: "2023:10:22 09:39:48"` (string).

---

## 5. Firefox — owner decision recorded

Firefox was measured at **42–45 seconds per 12.2 MP photo** (roughly 10× the
other engines) and then **crashed the tab on the fourth consecutive file**
(`Execution context was destroyed`, followed by loss of page globals). The
fail-on-fourth pattern suggests memory accumulating across files rather than any
single image being too large. Root cause was **not** investigated: the owner
directed that Chrome and Safari working is sufficient.

**Spec impact.** `decisions.md` §Constraints says "Admin browser is flexible —
whichever browser works best… but no dependence on one." That should now read:
admin is supported on **Chromium-based browsers and Safari**; Firefox is
unsupported for admin. **The display site is unaffected** — viewing WebP in
Firefox is fine, so `design.md` §Technology's browser support matrix stays as
written for viewers.

---

## 6. Open decision — Display P3 → sRGB conversion (O1)

**All four** owner photos are Display P3. The pipeline currently performs **no
colour conversion**: libheif's raw sample values are written into artifacts
labelled sRGB, which reinterprets rather than converts them.

Measured against macOS ColorSync's own P3→sRGB conversion of the same file
(200×200 sample grid, per channel, 0–255):

| channel | mean abs | p95 | max | mean signed |
| --- | --- | --- | --- | --- |
| R | 1.29 | 3 | 13 | +0.56 |
| G | 0.60 | 2 | 6 | −0.21 |
| B | 0.94 | 3 | 21 | +0.28 |

**Interpretation.** The error is small on average and concentrated in the most
saturated pixels. This is consistent with decision #3 ("the fidelity loss is
marginal for family photos"). **Caveat:** the test image is an overcast sunset
scene and mostly low-saturation, so these figures likely *understate* the worst
case for vivid subjects. A saturated fixture would tighten the bound.

**The decision to make.** `design.md` currently states wide-gamut colour is
"converted rather than preserved," which implies a conversion that does not
exist. Either:

1. **Implement it** — a 3×3 matrix applied in linear light, roughly 30 lines,
   removing the deviation entirely; or
2. **Document the deviation** and amend `design.md` to say wide-gamut sources
   are *reinterpreted* as sRGB, with the measured error recorded.

Either is defensible. What is not defensible is leaving the spec claiming a
conversion the code does not perform. **This needs an owner decision.**

---

## 7. Proposed amendments, document by document

### `decisions.md`

- **New decision — HEIF orientation.** libheif applies `irot`; EXIF orientation
  must be ignored on the libheif path and applied on the `createImageBitmap`
  path. Include the reason it is not merely an implementation detail: the wrong
  behaviour is dimensionally self-consistent and passes a dimensions-only test.
- **New decision — EXIF parsing options.** `reviveValues: false` **and**
  `translateValues: false`, with D2/D3 rationale.
- **Amend #13 (R2 conditional writes).** Record that support is confirmed on
  both surfaces; that failures differ (412 versus `null`); that **R2's strong
  consistency is the reason the retry loop is correct**; and that Miniflare's
  emulation may invert `onlyIf`.
- **Amend §Constraints (admin browser).** Firefox unsupported for admin, with
  the measured 10× slowdown and crash as justification.
- **Amend #3 (sRGB everywhere)** once O1 is decided.
- **Amend #4 (50 MP cap).** Keep the cap; note the justification is
  forward-looking — the owner's current devices are 12.2 MP — and that 48.8 MP
  was validated at ~12.5 s.

### `design.md`

- §Implementation validation: mark both day-one spikes resolved; restate the R2
  item as a Phase 1 account-setup verification.
- §Technology: note that the admin pipeline is supported on Chromium and Safari;
  leave the viewer support matrix unchanged.
- §Image files: correct the wide-gamut sentence per the O1 decision.
- §Image files: note that the full-resolution JPEG is often larger than the
  HEIC source, so it is not mistaken for a defect.

### `implementation-plan.md`

- §Upload and commit flow step 2: specify the exifr option pair and the
  path-dependent orientation rule.
- §Testing: add a **portrait-HEIC pixel-orientation regression test**; state
  explicitly that dimension assertions are insufficient for orientation.
- §Testing: require catalog conflict-retry tests to run against a controlled
  in-memory fake, **not** Miniflare's R2 emulation.
- §Testing: add a timezone test — a photo whose EXIF local time is early morning
  must land on the same calendar day regardless of the parsing machine's zone.
- §Architecture / §Opaque route handling: note libheif-js inlines its WASM into
  the JS bundle, so `'wasm-unsafe-eval'` is required but no separate `.wasm`
  fetch needs allowing in `connect-src`.
- §Delivery phases: processing must be **strictly serial**; the "three files in
  flight" concurrency belongs to uploads only. Three simultaneous 48 MP decodes
  are a memory risk.
- §Upload and commit flow step 2: the megapixel check must run from container
  or EXIF headers **before** full decode, or an oversized file exhausts memory
  before the guard fires.

### Pre-existing inconsistency, unrelated to the spikes

`implementation-plan.md` §Upload and commit flow step 1 has the admin API
increment the catalog batch counter at begin-batch, while step 6 states
"nothing is persisted server-side before commit." Both cannot be true. The
consequence is harmless — abandoned batches leave gaps in the sequence — but
the wording should be reconciled so it does not later read as a defect.

---

## 8. What was NOT validated

- Live R2 conditional-write behaviour against a real bucket (no account yet).
- Real Safari, as opposed to Playwright's WebKit.
- A genuine 48 MP iPhone HEIF Max capture. The 48.8 MP fixture is an upsample,
  so it is dimensionally honest — which is what governs time and memory — but
  does not reproduce Apple's 48 MP tile structure or an HDR gain map. Since
  libheif composited a real 48-tile Apple grid correctly, residual risk is low.
- Colour behaviour on a highly saturated source (§6).
- Firefox root cause (deliberately dropped).
- Memory ceilings under sustained batch processing in Chromium/WebKit. Firefox's
  crash suggests per-file memory release is worth an explicit check before
  large batches are attempted.

## 9. Reproduction

The harness is scratch work outside the repository and is not intended to be
committed. It comprises a Vite page running the pipeline, a Playwright driver
across engines, a summariser, a pixel-level orientation comparator, and a
colour-deviation comparator.

The four source photos live in `sample-photos/`, which has been added to
`.gitignore` — the repository is intended to be public and these are real family
photos. `.gitignore` is currently the **only** change to the repository; no spec
document has been modified.
