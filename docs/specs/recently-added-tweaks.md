# Recently added: simpler rule, plainer notice — and one fix to the photo view

Spec, 2026-09-05. A separate agent implements this. The decisions below are
settled unless marked "implementer's discretion". Where this spec and the code
disagree, the spec wins; where it and `docs/design.md` disagree, the spec wins
and the doc is updated (section 10).

`docs/specs/recently-uploaded.md` is the spec this amends. It is a historical
record and is **not** revised: this document supersedes its sections 2 and 10,
and part of 11.

## 1. Outcome

Four changes. Three make the Recently added view easier to explain to the
person using it; one is unrelated and fixes the Photo info panel in the photo
view.

1. **The recency rule loses its floor.** What is in the view is "anything
   uploaded in the last 30 days, plus the rest of any upload it lands in", and
   nothing else. Today it is that union'd with "the 50 newest, whatever their
   age", which cannot be said in a sentence and means the view usually shows
   photographs that are not recent by any reading.
2. **The window widens from 14 days to 30**, so losing the floor does not make
   the view thin in a quiet fortnight.
3. **The unseen dot becomes words.** A small bold green all-caps notice reading
   `NEW PHOTOS YOU HAVEN'T SEEN`, to the *left* of "Recently added".
4. **The Photo info panel closes like a panel.** Escape closes it and leaves
   the photograph open; clicking outside it closes it.

Plus one piece of spacing: the gap between a group's subtitle and its first
row of photographs is too tight.

Everything else about the view is unchanged — the routes, the sitting
boundary, the capture ordering inside a sitting, the wording of headings and
subtitles, the admin's curation, `timeline-patch`, and the localStorage key.

## 2. The recency rule

`src/shared/constants.ts`: delete `RECENT_FLOOR`. Change `RECENT_WINDOW_DAYS`
from `14` to `30`. `RECENT_GAP_HOURS` is unchanged.

`src/shared/display-api.ts`, `recentSet`: drop the floor pass. With
`L = livePhotos(catalog)` the set becomes

```
B = { p ∈ L : nowMs − Date.parse(p.createdAt) < 30 days }
S = { p ∈ L : p.batchSeq ∈ { q.batchSeq : q ∈ B } }
```

which is the current function minus one line:

```ts
function recentSet(live: readonly PhotoRecord[], nowMs: number): PhotoRecord[] {
  const byArrival = [...live].sort(compareByArrival);
  const windowMs = RECENT_WINDOW_DAYS * DAY_MS;

  const batches = new Set<number>();
  for (const photo of byArrival) {
    if (nowMs - Date.parse(photo.createdAt) < windowMs) batches.add(photo.batchSeq);
  }

  return byArrival.filter((photo) => batches.has(photo.batchSeq));
}
```

Everything true of the old rule that is still true stays true and stays
commented: trashed photographs are excluded at every stage including the
closure, one closure pass suffices because sharing a `batchSeq` is an
equivalence relation, and there is no ceiling — an 800-photograph import
inside the window appears whole.

Rewrite the docblock. The floor's rationale ("keeps the view from being thin")
is gone and the reason it went is worth recording where the code is: a view
whose contents cannot be described in one sentence is a view nobody trusts,
and "the 50 newest, or the last month, whichever is more" is two sentences
pretending to be one. `compareByArrival` stays — it still orders the sitting
and still supplies `uploadedAt`.

**The response contract does not change.** `RecentGroup` keeps every field.
The one doc comment that must change is on `TimelineResponse.recent`, which
currently promises "Empty only when the library is empty"; it is now empty
whenever nothing has arrived within the window, which is an ordinary state
rather than an edge case.

## 3. The empty view

`/recent` still exists, is still reachable from the toggle, and still never
404s when it holds nothing. `RecentPage` renders, in place of the groups:

```tsx
<Empty>No photos uploaded in the last month.</Empty>
```

`Empty` already takes its text as children, so no change there.

The copy says "the last month" where the constant says 30 days. That is
deliberate and should not be reconciled: 30 days is a rule that has to be
exact, and "the last month" is how the sentence is heard. Do not write "the
last 30 days", and do not derive the string from the constant.

The comment above this branch in `RecentPage` currently reasons from the floor
("with a floor of 50 it is empty only when the library itself is"). Replace
it: this is a fixed part of the site, like the Undated section, so an empty
one says so rather than disappearing or 404ing — a family member who followed
the toggle deserves an answer, and "nothing lately" is an answer.

## 4. The notice, in place of the dot

`src/shared/ui/ViewToggle.tsx`. Delete the `view-toggle__marker` span and the
`visually-hidden` span inside the link. In their place, a sibling **before**
the Recently added element — so the nav reads `All photos` · notice ·
`Recently added`:

```tsx
{unseen ? (
  <span className="view-toggle__notice">New photos you haven’t seen</span>
) : null}
```

Notes, all settled:

- **Sentence case in the DOM, uppercase in CSS** (`text-transform: uppercase`).
  Some screen readers spell out an all-caps string letter by letter, and the
  notice exists to be understood.
- The apostrophe is U+2019 (`haven’t`), matching the typography elsewhere in
  the interface (`Preparing download…`, the en dash in capture spans). Tests
  that query the string must use the same character.
- **Not a link.** It sits immediately beside the link that acts on it, and a
  control that duplicates its neighbour is one more thing to understand. It
  carries no `aria-*`: it is literal text, and a screen reader reads it in
  order, before the link it describes.
- The condition is exactly the one the dot had — `unseen` from
  `useUnseenRecent`, which is false on `/recent` itself, false when storage is
  unavailable, and false when the response carries no sitting at all. None of
  that logic changes; `src/shared/ui/unseen.ts` is untouched apart from its
  docblock, which calls the thing a dot.
- Update the `ViewToggle` docblock, which explains the choice of a dot over a
  count partly by "the recent set has a floor of 50". The floor is gone; the
  argument against a count is not. Say instead that a count needs a per-device
  diff that goes wrong after a delete, for a number nobody acts on differently
  than a notice.

### Styles

`src/shared/styles/display.css`. Delete `.view-toggle__marker` and, with its
last user gone, `.visually-hidden`. Add:

```css
/* Something has arrived that this browser has not been shown. Emphasis only:
   it never changes which photographs are in the set, and it is absent
   entirely where storage is unavailable. */
.view-toggle__notice {
  color: var(--notice);
  font-weight: 700;
  font-size: 0.75rem;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  white-space: nowrap;
}
```

**The green is a new colour in the interface and needs a token.** The palette
has no green: `base.css` holds neutrals plus `--focus` (`#2563eb`, `#60a5fa`
in dark), and the only other colour anywhere is the `#b91c1c`/`#fca5a5` red
that `admin.css` reserves for everything destructive. So add a pair beside the
others in `src/shared/styles/base.css`:

```css
/* The recency notice, and nothing else. Not the blue of a link — it is not
   one — and pointedly not the red the admin reserves for what destroys. */
--notice: #15803d;
```

with `#86efac` in the `prefers-color-scheme: dark` block. Those two are the
same weights as the existing red pair (700 on the light ground, 300 on the
dark), so the notice carries the same emphasis in both themes and clears
contrast on each.

Leave `.admin-danger` and `.admin-error` alone. Their literals are outside
this change, and the rule `admin.css` states about its red — that everything
which destroys something wears it and nothing else does — is now true of the
green as well: the notice is the only thing wearing it, and it acts on
nothing.

### The header must not wrap

At 40rem and up the header is sticky and its height is a **declared constant**
(`--layout-header-height: 3.5rem`), which every sticky offset and every
`scroll-margin-top` in both stylesheets is built from. `.layout__header:has(
.layout__nav)` is therefore `flex-wrap: nowrap`. Adding ~28 characters to that
row can overflow it between 40rem and roughly 55rem, in the admin especially,
where the nav also holds Trash and Export catalog.

Resolve it by letting the **site title** yield, inside the existing
`@media (min-width: 40rem)` block:

```css
.layout__header:has(.layout__nav) .layout__site-title {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.layout__nav {
  flex: none;
}
```

The title is the one thing in that row the reader already knows; the notice
and the toggle are the things they are there to act on. Below 40rem nothing
changes: the header is in flow, `flex-wrap: wrap` is in force, its height is
not a constant, and the notice may take a line of its own.

Verify at 640px, 768px and 1280px in both apps, with the notice showing, that
the header is still exactly 3.5rem tall and nothing is clipped but the title.

## 5. Space under the subtitle

The gap between a group's subtitle and its first row of tiles is too tight
(the whole of it is `--recent-subtitle-height`'s slack, which is none).

Below 40rem, where both lines are in normal flow: `.recent__subtitle`'s
`margin: 0 0 0.5rem` becomes `0 0 0.75rem`.

At 40rem and up the two lines are a pinned block whose height is declared, and
the tiles' `scroll-margin-top` is built from the same custom properties in
both stylesheets. So add the space **inside the band**, not after it:

- `--recent-subtitle-height: 1.75rem` becomes `2.25rem`.
- `.recent__subtitle` inside the `@media (min-width: 40rem)` block gains
  `padding-bottom: 0.5rem`.

Everything is `box-sizing: border-box`, so the flex centring happens in the
1.75rem content box and the text stays exactly where it is; the extra half-rem
is opaque background beneath it. Because the two tile rules in `display.css`
and the two in `admin.css` all add `var(--recent-subtitle-height)`, they
follow automatically and the pinned block and the scroll offsets stay in
agreement — which is the invariant that must survive this change.

Do it this way round rather than by putting a margin under the subtitle: a
margin is not part of the sticky band, so a tile scrolled to under a pinned
subtitle would still touch it.

## 6. The Photo info panel

`src/shared/ui/Lightbox.tsx`. Two changes, both about the panel being a layer
that can be dismissed on its own.

### 6a. Escape unwinds one layer

In the `keydown` layout effect:

```ts
case 'Escape':
  event.preventDefault();
  if (showInfo) setInfoFor(null);
  else onClose();
  break;
```

`showInfo` joins the effect's dependency array.

This makes Escape consistent with what the view already does for the edit
form, where the first Escape leaves the field and only the second closes the
view: Escape dismisses the innermost thing that is open. The two guards above
the switch are untouched and keep their precedence — a focused form field
still swallows Escape first (so in the admin, with a field focused and the
panel open, it takes three presses to leave), and a focus outside the dialog
still means the keyboard is not ours.

### 6b. Clicking outside closes it

Add a ref to the panel and a ref to the Photo info button, and while the panel
is open listen for `pointerdown` on `window`:

```ts
useEffect(() => {
  if (!showInfo) return;
  function onPointerDown(event: PointerEvent) {
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (infoRef.current?.contains(target)) return;
    if (infoButtonRef.current?.contains(target)) return;
    setInfoFor(null);
  }
  window.addEventListener('pointerdown', onPointerDown);
  return () => window.removeEventListener('pointerdown', onPointerDown);
}, [showInfo]);
```

Three things this shape is deliberately getting right, and each deserves its
comment:

- **The toggle button must count as inside.** It is not, geometrically, but if
  the outside handler closes on `pointerdown` and the button's own `onClick`
  then runs against a re-rendered `showInfo` of `false`, the panel reopens on
  the very click meant to close it. Excluding the button leaves the button's
  existing toggle as the only thing acting on that click.
- **`pointerdown`, not `click`.** It covers touch, and it fires at the start
  of a drag, so dragging a selection out of the panel and releasing over the
  photograph does not count as clicking outside.
- **Containment on the panel itself**, so dragging its scrollbar (it is
  `overflow-y: auto` with a `max-height`) does not dismiss it.

A passive effect is correct here; nothing about it races the paint, unlike the
key handler and the scroll lock next to it.

Everything else stays: the panel is still keyed to `infoFor === photo.id`, so
arrowing to the next photograph still closes it as arithmetic rather than as
an effect, and `aria-expanded`/`aria-controls` are unchanged.

## 7. The development fixture

**This is the one non-obvious consequence of section 2, and it will look like
a bug in the e2e suite if it is missed.**

Every photograph in `fixtures/catalog.ts` is created at the literal
`2026-08-03T10:00:00.000Z` (the default in `fixtures/photos.ts`). Today that
is 33 days ago. The floor is what currently puts the fixture library in
`/recent`; without it, every Recently added end-to-end test finds an empty
page — and the fixture would rot again on whatever date it were reset to.

So give the fixture library a **relative** arrival. In `fixtures/catalog.ts`
only:

```ts
/**
 * When the fixture library arrived: one sitting, comfortably inside the
 * recency window, and relative because that window is relative. A literal
 * here is a test suite with an expiry date.
 */
const FIXTURE_UPLOADED_AT = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
```

`toRecord` passes it as both `createdAt` and `updatedAt`. Do **not** change
the default in `fixtures/photos.ts`: `makePhoto` is the unit tests' factory
and several of them pin a fixed `NOW_MS`, so its literal is load-bearing.

Consequences, all of which are intended:

- One sitting, 26 hours old, holding every live photograph — exactly what the
  e2e suite asserts today (one `.recent__group`, 18 photos, the December 2025
  – August 2026 span, "and 2 undated"). Every existing assertion keeps
  passing, including the mobile subtitle-wrapping test.
- The label is "Added yesterday" rather than "Added today" for a reader in the
  fixture server's own zone, which is what the suite already expects.
- The unit tests that build a response from `fixtureCatalog()` against a fixed
  `NOW_MS` (`timeline-patch.test.ts`) stay correct as real time passes: an
  arrival *later* than `nowMs` yields a negative age, which is inside the
  window.

The alternative — ageing the two undated photographs out of the window so the
browser also exercises exclusion — was considered and rejected for this
change: it buys coverage that section 9's unit tests already give, in exchange
for editing e2e assertions in three files.

## 8. What does not change

Stated so it is not touched in passing: the `/recent` and `/recent/photo/<id>`
routes; the six-hour sitting boundary; `comparePhotosByCapture` and the order
inside a sitting; every string in `recent-labels.ts`; `RecentGroup`'s shape;
`timeline-patch.ts`; the admin's view-dependent `orderedIds`; the
`photo-site:recent-seen` key and everything else in `unseen.ts`; and the whole
of the library view.

The Worker is untouched. It never calls `timelineResponse`, so this ships to
Netlify alone — but the change is in `src/shared/`, so confirm that against
the table in `README.md` rather than from memory.

## 9. Tests

**`tests/unit/recent.test.ts`** — the floor is gone, and so is most of the
scaffolding these tests needed to work around it:

- Delete the two floor tests, and the `RECENT_FLOOR` filler arrays in the
  window and closure tests. Those exist only to use the floor up; without it
  a three-photograph catalog proves the rule directly.
- The boundary test moves to 30 days: an arrival at `30 days − 1ms` is in, one
  at exactly `30 days` is out (`<`, not `<=`, unchanged).
- New: a library whose every photograph is older than the window produces
  `[]`. This is the case that could not previously happen and is now the
  ordinary one.
- New: a photograph two months old is pulled in by closure when a sibling of
  its `batchSeq` arrived yesterday — now expressible in two records.
- Keep, unchanged: trashed exclusion, determinism, the gap-boundary pair, the
  reload-split sitting, the two-sitting case, `uploadedAt` naming, the
  range/undated/count assertions, and the ids-subset invariant.

**`tests/unit/recent-page.test.tsx`** — the empty-state assertion becomes
`No photos uploaded in the last month.`, and its comment stops reasoning from
the floor. The aged-out-lightbox describe block is unaffected.

**`tests/unit/lightbox-info.test.tsx`** (new, `@vitest-environment happy-dom`)
— render `Lightbox` the way `recent-page.test.tsx` already does, with a spy
`onClose`:

- Opening Photo info and pressing Escape closes the panel and does **not**
  call `onClose`; a second Escape calls it.
- Escape with the panel closed calls `onClose` (the existing behaviour, now
  worth pinning).
- `pointerdown` on the dialog outside the panel closes it.
- `pointerdown` inside the panel leaves it open.
- Clicking the Photo info button while the panel is open closes it and leaves
  it closed — the regression the button-is-inside rule exists for. Fire a
  full `pointerdown` + `click` sequence, or the test cannot see the bug.

**`tests/unit/view-toggle.test.tsx`** (new, happy-dom) — with `unseen`, the
notice renders, reads `New photos you haven’t seen`, and precedes the Recently
added link in document order; without it, nothing renders; on `/recent`
(`current: 'recent'`) nothing renders.

**`tests/e2e/recent.spec.ts`** — `.view-toggle__marker` becomes
`.view-toggle__notice` in the three places it appears, and the first
assertion also checks the text. The rest of the file is unchanged.

**`tests/e2e/display.spec.ts`** — one new test for section 6, which is the
half of this change that a unit test proves and a browser proves differently:
open a photograph, open Photo info, press Escape, and assert the panel is gone
while `.lightbox__image` is still visible; then click the photograph itself
and assert the panel closes; then Escape and assert the listing is back.

Run `npm run check` and `npx playwright test`. Both must be clean, with only
the two pipeline tests skipping for the absent `sample-photos/`.

## 10. Documentation

**`docs/design.md`**, in "Display site":

- The two-views bullet: the dot becomes the notice, described as words rather
  than a mark, still per-device, still emphasis only, still cleared by one
  visit.
- The "What counts as recently added" bullet loses the floor and the fortnight
  and becomes the one sentence this change is for: everything uploaded in the
  last 30 days, plus every photograph sharing an upload batch with any of it,
  trashed photographs excluded, no ceiling. Add that the view can be empty,
  and what it says when it is.
- The photo-view bullet (around line 310) gains the panel's dismissal: Escape
  closes the Photo info panel before it closes the photograph, and clicking
  outside the panel closes it.

**`docs/decisions.md`** — a new dated section, `## Saying what "recently
added" means — 2026-09-05`, continuing the numbering from 63:

64. The floor removed. The rule a reader cannot state is a rule they cannot
    trust; the floor also meant the view routinely showed photographs that
    were not recent by any definition. The window widened to 30 days so that
    losing it does not empty the view in a quiet fortnight, and an empty view
    is now a normal state with a sentence of its own.
65. Words in place of the dot. The dot said *that* something was new and
    nothing about *what*; the notice is the first thing in the row that
    explains itself. It is green rather than the dot's blue, which reads as a
    link, and rather than red, which the admin reserves for what destroys —
    the third colour the interface has ever had, and it earns its place by
    being the one thing on the page that is about the reader.
66. Escape unwinds one layer. Matches the edit form, which has behaved this
    way since the admin became the viewer; the panel was the odd one out.
67. The fixture's arrival made relative. A window rule cannot be exercised by
    a fixture with a literal date in it — the suite passes until the calendar
    moves. Note that `makePhoto`'s literal deliberately stayed.

**`docs/implementation-plan.md`** (around line 306) — the constants list drops
`RECENT_FLOOR`.

**`docs/specs/recently-uploaded.md`** — not revised. It is the record of what
was decided on 2026-09-04.

`README.md` and `CLAUDE.md` need no change.

## 11. Implementer's discretion

- Exact type scale of the notice (`0.75rem`/`700`/`0.04em` above is a
  starting point), so long as it reads as a notice rather than a third
  navigation item and does not change the header's height.
- Whether the new `view-toggle` and `lightbox-info` unit tests are two files
  or one; two is suggested because they share nothing.
- Where in `Lightbox` the two refs are declared, and whether the pointer
  handler lives in the component body or a small helper above it.
