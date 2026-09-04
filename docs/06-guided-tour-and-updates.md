# 06 — Guided tour and Updates

Design for two connected surfaces:

- **Guide** — a step-by-step walkthrough that moves the person through the real
  application, highlighting the actual control it is talking about.
- **Updates** — a changelog the person can open at any time, where a new entry
  can hand off to a short Guide run for the thing that changed.

This document is the design and the impact assessment. Both surfaces have
since been built; §0 records where the implementation departs from what
follows, and why.

Status: **both built.** Open questions are in §14 and mirrored into
`OPEN-QUESTIONS.md`. What shipped differs from this design in several places —
those are listed in §0 rather than edited into the body, so the reasoning
behind each original decision stays readable next to what actually happened.

---

## 0. As built

Both halves are implemented, unit-tested, and driven end to end in a browser.

**Where it starts.** On the sign-in screen, not the dashboard. `SignInTourOffer`
renders under the form for anyone who has neither taken the tour nor declined
it; "Show me around" parks a request in the store and `GuideOverlay` collects
it on the first authenticated render. The post-sign-in invitation popover in
§4.1 was not built — the offer lives at the door instead, which is what "start
from the login screen" asked for and one fewer interruption.

**Two scopes, and the page one is primary.** The first build was a single
linear tour, which made the commonest question — "what is this screen for?" —
cost ten steps to reach Approvals and sixteen to reach Settings. That is the
wrong shape for every day after the first. The registry is now organised per
screen and the whole-product tour is derived from it:

| Scope | Length | Reached from |
|---|---|---|
| **This screen** | 1–4 steps | The pin icon in the header, the account menu, or `Ctrl+F1` |
| **Whole product** | 8–21 steps | Account menu → "Take the tour", and the sign-in offer |

`Ctrl+F1` carries it because PRD §6.4 already calls that key "contextual help /
shortcut sheet" and the dialog was only doing the second half. But a keyboard
shortcut was the *only* way in at first, and that was a bug rather than a
choice: the header's shortcut button is `hidden sm:inline-flex` and a phone has
no F1, so on the width most people use, the per-screen guide existed and could
not be reached. Verified in a browser — at 390px the shortcut button measures
zero. It is now listed in the account menu at both widths, above the full tour
because "what is this screen for?" is asked far more often than "show me
everything". The Calculator row directly beneath it exists for exactly the same
reason, and its comment already said so.

**It is in the header now, and it covers every screen.** Two faults were found
by using it rather than by reading it. The control had no place in the header
at all, so it was only reachable by somebody who had already decided to go
looking — it is now a pin icon beside Go to, present at every width. And the
registry knew about sixteen screens while the product had thirty-nine: the
Dashboard, Corrections, Team leave, My tasks, Organisation, Recycle bin,
Analytics and the entire Phase 6–8 CRM, masters and sales/purchase module had
no guide, so pressing the control on any of them did nothing at all — silently,
because an empty step list makes `start()` return early. All thirty-nine are
covered, and `guide-anchors.test.tsx` now fails if a screen reaches the
navigation without one, which is the only thing that stops it happening again.

**The sidebar is not the product.** A later sweep found the coverage test had
been asking the wrong question: it read `ALL_NAV_ITEMS`, and twenty-two routed
screens are not in the sidebar — the employee detail page, the four document
editors, the three paper views, and the account screens (`/profile`,
`/updates`, `/notifications`, `/administration`). All of them wear the shell,
all of them show the header pin, and on all of them the pin did nothing. The
test now reads the route table out of `App.tsx`, so a route added there is a
route it knows about.

Two mechanisms came out of that. Paths carrying an id are matched by pattern
(`/sales/orders/:id`), and an unmatched path falls back to its parent — several
screens render the same component for the list and for one selected row, so
`/crm/deals/abc` is the deals screen with a panel open and gets the deals
guide. An explicit entry always wins over the fallback, which is why
`/sales/orders/new` gets the editor's own step and not the list's. `introFor`
stays strict for the coverage test; only the runtime resolver is forgiving.

The document screens needed a second anchor. None of the seven renders a
`PageHeader`, so `screen.header` is absent; they all render `DocumentEditor`,
and its toolbar carries `screen.document`. Three of them were driven in a
browser. The other four need a saved document to get past their loading state,
which a stubbed API cannot produce, so what they depend on is asserted in a
test instead: every one of the seven reaches `DocumentEditor`, and
`DocumentEditor` carries the anchor.

**The changelog is the half that rots quietly.** On 31 Aug 2026 the Updates
page still named 0.9.0 from 13 Aug — eighteen days and 496 commits to the web
app behind, with two-step sign-in, the Tally masters projection, the rebuilt
reports, order-to-dispatch, collections, the CRM dashboard and the task
dashboard all shipped and none of them mentioned. One entry was actively wrong:
it said Reports had been removed, while the router serves twenty-seven report
screens.

`changelog.test.ts` could not see any of that. It checks every entry is
*correct* — the route exists, the tour step exists, the permission matches the
navigation — and a missing entry is invisible to a test of the entries that are
there. `scripts/check-changelog.mjs` now reports what has shipped since the
newest release and which REQ ids are undescribed. Run against the stale state
it reported 496 commits and 195 undescribed ids, which is the proof it works.

It is **advisory and exits zero**, deliberately. Release notes are editorial,
and a build that refuses to pass until somebody writes prose gets worked around
rather than obeyed. It is a list to read when closing a phase, not a gate.

**What the sweep is worth beyond the guide.** Driving all seventy-one
navigable screens to see whether the pin works is also, incidentally, a crash
detector: a screen that fails while drawing itself renders no `PageHeader`, so
the guide reports it. Sixty-seven started their guide. Two crashed -
`/collections` and `/masters/portal-links` - and two more were probe timing,
confirmed by re-running them. The crashes are recorded as OPEN-QUESTIONS G-11
with what is and is not proven: the payloads were the probe's, but the reason
they crashed rather than degraded is that twelve of sixty-six files calling
`apiRequest` never parse the response, where the other fifty-four do.

**Breadth was covered; depth was not.** Every screen had a guide, and each one
said almost nothing: the intro plus whatever of three anchors happened to be
present - search, table, pagination. Meanwhile the shared kit had grown to
forty-odd components, and the things people actually ask about were unnamed.
Nine more anchors now sit on the kit: the KPI strip (21 screens), the chart
card, the tab strip, the row menu, saved views, presence, the board, the
matrix reads, and the attachment panel. Ordered the way a screen is read -
presence, tabs, saved views, search, figures, chart, board, matrix, records,
row actions, attachments, pagination - so the guide walks down the page.

Measured before and after on the running app: Employees went 2 to 5 steps,
Roles 1 to 3, the Dashboard 1 to 3, Deals 2 to 3. Ten of the thirteen anchors
were seen rendering and guided in a browser; the remaining four - presence,
board, matrix, attachments - need a record sheet open or a board with cards,
which a stubbed API cannot produce, so a test asserts the component carries
the attribute and that every anchor has a step to explain it.

A page guide is composed by **looking at the page**, not from a per-route list
that would go stale the first time a screen gained a table. The screen's intro
comes from the registry; the rest is whatever of the shared kit is actually on
screen — search, records, pagination. Measured live: Employees with data gives
four steps, Approvals and Punch and Audit showing empty states give one each.
Furniture never appears in the whole-product tour, because sixteen screens each
repeating "this is the table" is what would make the long tour unbearable.

That cost three attributes, not eighteen: `SearchField`, `RecordTable` and
`RecordPagination` are shared components that 5, 23 and 10 screens respectively
already use, so a screen earns its steps by being built out of the kit.

**Length of the whole-product tour**, one step per screen rather than the
sub-steps in §4.1:

| Seeded role | Steps | On a phone |
|---|---|---|
| Employee | 8 | 7 |
| Operations | 13 | 12 |
| HR | 17 | 16 |
| Admin | 21 | 20 |

The phone loses one because the shortcut sheet is a desktop-only control and
its step declares `mobileBehaviour: 'skip'` rather than pointing at nothing.
All measured against the real `ROLE_PERMISSION_MATRIX`, not asserted.

**Anchors: seven, not twenty-two.** Every screen step points at
`screen.header`, which sits on the one shared `PageHeader` component all
eighteen screens render. Eighteen attributes became one, and the drift risk
collapses with it — a refactor cannot lose one screen's anchor quietly,
because there is only one to lose.

**The anchor guarantee is two layers, and G-8 is fully met.** `apps/web` had
no test runner at all — vitest lived only in `apps/api` — so the first pass
shipped `scripts/check-guide-anchors.mjs`, which reads the source and runs as
part of `pnpm lint`. That catches a *deleted* attribute but is blind to a
*duplicated* one. Vitest, jsdom and testing-library were then approved and
added, and `guide-anchors.test.tsx` renders the real shell at both widths and
asserts every anchor resolves to exactly one element.

Both layers were falsified rather than assumed: renaming `screen.header`
fails the static check and two render tests; adding a second
`header.breadcrumb` passes the static check — which reports "all present" —
and fails the render test. That difference is the whole justification for the
dependency.

**Updates.** `/updates`, off the sidebar and reached from the account menu,
exactly as §9 describes. The changelog is a typed module, permission-filtered
per entry, with an unread dot on the avatar cleared by opening the page.
`changelog.test.ts` asserts every "Take me there" points at a real route,
every "Show me" at a real tour step id, and — across the whole role matrix —
that no role can see an entry whose destination would refuse it.

**The mini-tours in §4.5 became one line instead of a second registry.** An
entry carries a `guideStep`, and "Show me" starts the *main* tour at that
step. The step already knows its route and carries its own permission, so a
separate `MINI_TOURS` map would have been a second thing to keep in step with
the first. Verified: "Show me" on Period lock lands on `/period-lock` at step
17 of 21.

**Reduced motion follows the repo, not §6.1.** `index.css` already collapses
every transition to 0.01ms under `prefers-reduced-motion`, deliberately and
with its reasoning written down. §6.1 wanted a 150ms fade kept. Punching a
hole in an existing accessibility policy is not a change to make in passing,
so the blanket rule wins and the tour cuts rather than fades. Raise it if the
gentler behaviour is wanted.

**Keys are arrows, not Enter.** `→` next, `←` back, `Esc` stop. §8 proposed
Enter, which was wrong: the dispatcher runs in the capture phase, so Enter on
the Back button would have moved the tour forwards. Enter is also "drill down"
in PRD §6.4 and is left alone.

**A geometry bug only a screenshot found.** A records table is routinely taller
than the window. The cutout took the element's own rectangle, so on Employees it
covered the entire screen — dimming nothing, which defeats the point of a
spotlight — and pushed the card off the bottom edge. The rectangle is now
clamped twice: intersected with the viewport, so an anchor scrolled half out of
view cannot drag the cutout off with it, and capped at 42% of viewport height,
so a long table is highlighted by its header and first rows. The card is
positioned against that same clamped rectangle rather than against the raw
element, so the hole and the card can never disagree.

**One bug worth recording.** The tour first ran with an empty permission set
and froze a five-step list for an administrator entitled to twenty-one — every
screen step silently filtered as unpermitted. `SessionGate` writes permissions
in an effect and React runs a child's effects before its parent's, so
`GuideOverlay` was starting before the store was filled. It is now gated on
`sessionStatus === 'authenticated'`. Nothing about the code looked wrong; only
driving it showed the counter reading "of 5".

---

## 1. What this is, and what it is not

**It is** product orientation: where things are, what a control does, what
changed in the last release.

**It is not**:

- Employee onboarding. PRD §1 lists "recruitment, onboarding workflows" as
  non-goal N3. That is an HR process about a new hire. This is a UI walkthrough
  about the software. They share a word and nothing else.
- A help centre, a manual, or searchable documentation.
- A blocker. The Guide never gates a screen. A person who dismisses it can do
  everything they could do before it existed.

**The one rule that shapes everything below:** the Guide points at the live
application. It does not render screenshots, mock screens, or a simulated
sidebar. If it says "this is the Punch button", it is pointing at the Punch
button that works.

---

## 2. Module boundary

CLAUDE.md §2: nothing attendance-specific goes in a shared module, and no
platform concern goes inside the attendance module.

Orientation and release notes are a **platform** concern. The same machinery
has to carry the CRM and ERP modules later without being rewritten. So:

```
apps/web/src/features/guide/       Guide UI, step registry, overlay
apps/web/src/features/updates/     Changelog data + screen
apps/web/src/components/shared/    anchored-popover (the one missing primitive)
apps/web/src/lib/guide-store.ts    Seen-state, alongside nav-preferences-store
```

The step registry contains attendance step *copy*, which is content, not logic.
No punch rule, leave rule, or shift rule is ever read by the Guide. It knows
route strings and anchor names and nothing else. That keeps the boundary clean
when a CRM tour is added as a second registry file.

---

## 3. Entry points

There are exactly four ways in, and no fifth.

| # | Entry | Who sees it | Behaviour |
|---|---|---|---|
| 1 | **First sign-in** | Anyone who has never completed or dismissed the Guide | An invitation, not an auto-start. See §4.1 |
| 2 | **Account menu → "Take the tour"** | Everyone, always | Starts from step one, every time |
| 3 | **Shortcut sheet (`Ctrl+F1` / `F1`)** | Everyone | A "Take the tour" button under the shortcut list |
| 4 | **An Updates row → "Show me"** | Anyone opening Updates | Runs a two- to four-step mini-tour for that one entry |

`Ctrl+F1` is already the PRD §6.4 contextual-help key and already opens the
shortcut sheet. The Guide joins that sheet rather than claiming a key of its
own — the Tally key table in §6.4 is authoritative and has no free slot for a
tour, so inventing one would be a spec violation.

---

## 4. The user flow, step by step

### 4.1 First sign-in, desktop

**Step 0 — the invitation.** Not the tour. A single Popover anchored to the
account avatar, with two buttons.

```
┌────────────────────────────────────────────┐
│  New here?                                 │
│                                            │
│  A two-minute walk through the screens      │
│  you have access to. You can stop at any    │
│  point and pick it up from this menu.       │
│                                            │
│              [ Not now ]  [ Start ]         │
└────────────────────────────────────────────┘
```

It appears once, roughly 800ms after the dashboard settles — not on mount,
because a bubble that arrives during the first paint reads as a rendering
glitch. "Not now" records a dismissal and it never appears again unprompted.

Why an invitation rather than an auto-start: the same account type is used by a
shop-floor employee who opens Punch and closes the tab. Seizing their screen on
the first sign-in to explain the Reports menu they cannot open is hostile. The
Guide has to be asked for.

**Step 1 — Navigation.**

- Anchor: the sidebar's first nav group
- Route: `/` (already there)
- Copy: "Everything lives here, grouped by what you are doing. You only see
  what your role allows, so this list is shorter for some people than others."

**Step 2 — Go to.**

- Anchor: the "Go to" button in the header
- Bubble carries a live `<ShortcutHint keys="alt+g" />` chip
- Copy: "The fast path. Press Alt+G anywhere and type the first few letters of
  a screen."
- **Interactive:** pressing `Alt+G` while this step is showing opens the
  palette for real and advances the step. The Guide does not fake the keypress
  and does not block it.

**Step 3 — Shortcuts.**

- Anchor: the keyboard icon in the header
- Copy: "Every key on this screen, listed. The keys match TallyPrime wherever
  the browser allows it."

**Step 4 — Where you are.**

- Anchor: the breadcrumb trail
- Copy: "The page always names itself here."

**Step 5 — Your account.**

- Anchor: the avatar button
- Copy: "Theme, your profile, and the way out. The tour lives here too if you
  want it again."

**Step 6 — Updates.**

- Anchor: the "Updates" row inside the account menu — so the Guide **opens the
  menu** for this step and holds it open
- Copy: "What changed, and when. A dot appears here when there is something you
  have not read."

Steps 1–6 are the everyone tour. What follows is filtered by permission, and a
person with no matching permission goes straight to the closing card.

**Step 7+ — the role-shaped remainder.** Each block is included only if the
signed-in permission set grants it.

| # | Step | Gate |
|---|---|---|
| 7 | Punch | `punch.self` |
| 8 | The capture and the consent notice | `punch.self` |
| 9 | The half-day choice, offered only on an IN | `punch.self` |
| 10 | My attendance | `attendance.view.self` |
| 11 | My leave | `leave.apply.self` |
| 12 | Team attendance | `attendance.view.team` |
| 13 | Approvals | `leave.approve.team` |
| 14 | Reports | `report.view` |
| 15 | Downloads, and why an export is a job rather than a wait | `report.export` |
| 16 | Employees | `employee.view` |
| 17 | Shifts and rosters | `shift.manage` |
| 18 | Leave types | `leave.policy.manage` |
| 19 | Holidays | `holiday.manage` |
| 20 | Settings, and its four tabs | `settings.manage` |
| 21 | Roles and permissions | `roles.manage` |
| 22 | Period lock | `attendance.lock` |
| 23 | Audit log | `audit.view` |
| 24 | Integrations | `integration.manage` |

Every gate is a real key from `ROLE_PERMISSION_MATRIX`, so the length of the
tour is a property of the signed-in permission set and not a number written
anywhere:

| Seeded role | Steps |
|---|---|
| Employee | 11 |
| Operations | 16 |
| HR | 20 |
| Admin | 24 |

The counter reads "Step 9 of 16" for an Operations user and "Step 9 of 24" for
an Admin, because both are counting the same filtered list they are actually
walking. A fixed total would promise steps that will never arrive.

Each block's first step **navigates**. The Guide calls `navigate('/punch')`,
waits for the anchor to exist, then draws. See §6 for what happens when it does
not appear.

**What it does not do.** Two limits, both deliberate:

- It does not visit a screen the person cannot open. That is the whole point of
  the gate column.
- Within a screen it highlights **one** representative control, not every
  button on it. This is orientation — where things live and what the screen is
  for — not a manual. A tour that stopped on every control on the Settings
  screen would be forty steps long and nobody would finish it.

**Closing card.** Not anchored to anything — a centred Dialog.

```
┌────────────────────────────────────────────┐
│  That is the tour                          │
│                                            │
│  You saw all 16 steps.                      │
│  Alt+G gets you anywhere. Ctrl+F1 lists     │
│  every key. The tour is in your account     │
│  menu whenever you want it again.           │
│                                            │
│                             [ Done ]        │
└────────────────────────────────────────────┘
```

The 16 is the filtered length for whoever is reading it, not a constant. Where
steps were skipped because an anchor never appeared, it reads "You saw 14 of
16 steps" instead — the tour does not quietly claim to have shown something it
could not find.

### 4.2 First sign-in, phone

Same registry, three differences, all driven by `useIsMobile()` — the hook the
shell already uses to swap the account dropdown for a Sheet.

1. **The bubble is a bottom Sheet, not a Popover.** A 288px popover pinned near
   a control at 360px covers the control it is describing. The Sheet sits at
   the bottom, under the thumb, and the highlight stays visible above it.
2. **Sidebar steps are replaced, not skipped.** Step 1 anchors to the bottom
   navigation bar instead, with its own copy: "Four destinations plus More.
   Long-press More to choose which four." A step declares `mobileAnchor` to opt
   into this; without one it declares `mobile: 'skip'`.
3. **The scrim is lighter and the page still scrolls.** A phone tour that locks
   scroll cannot show a control below the fold.

Touch targets in the Sheet footer are the standard 44px minimum. Back, Skip and
Next sit in one row: Skip on the left, Back and Next paired on the right.

### 4.3 Resume

The Guide records the last completed step id, not an index — a step inserted
later must not move somebody two steps backwards.

If a run is abandoned (Esc, a reload, or a click on Skip) and the person starts
it again within seven days, the invitation reads:

```
  Pick up where you left off?
  You stopped at "Team attendance", step 12 of 20.

              [ Start over ]  [ Continue ]
```

If the recorded step id no longer exists in the registry, resume is silently
discarded and the run starts at step one. A version bump on the registry does
the same.

### 4.4 A new release lands

1. A release is added to `changelog.ts` with a version, a date and its entries.
2. On the next load, the client compares the newest release version against
   `lastSeenVersion` in the Guide store.
3. If it is newer, a **dot** appears on the avatar button and on the "Updates"
   row inside the account menu. No toast, no modal, no interruption. The person
   is working; a release note is not urgent.
4. Opening `/updates` marks everything up to the newest release as seen and
   clears the dot.

There is deliberately no "what's new" popup on sign-in. It is the single most
resented pattern in operations software, and this product's users open it
several times a day.

### 4.5 From a changelog row into a spotlight

This is the piece that ties the two surfaces together.

A changelog entry may carry a `tour` id. When it does, the row renders a "Show
me" button. Pressing it:

1. Closes the Updates screen
2. Navigates to the entry's route
3. Runs a **mini-tour** — the two to four steps registered under that id, and
   nothing else
4. Ends on a one-line closing card, not the full closing card

```
Updates                                          v0.9.0 · 12 Aug 2026

  Added   Period lock                                    REQ-E-09
          A month can now be closed so no punch or edit
          can change it after payroll input is handed off.
                                              [ Show me ]  →  spotlights the
                                                              Lock button on
                                                              /period-lock

  Changed Export runs as a job                           REQ-J-03
          Large exports no longer hold the screen. They
          appear in Downloads when ready.
                                              [ Show me ]

  Fixed   The bottom bar forgot its fourth tab on reload
```

---

## 5. The step registry

One typed array, colocated with the feature, read at render. No content in
components.

```ts
export interface GuideStep {
  id: string;
  /** Navigated to before the step draws. Omit to stay put. */
  route?: string;
  /** Matched against [data-guide="…"] in the live DOM. */
  anchor: string;
  /** Used instead of `anchor` below the 768px breakpoint. */
  mobileAnchor?: string;
  title: string;
  body: string;
  /** Preferred side; the positioner may flip it to avoid a collision. */
  side?: 'top' | 'bottom' | 'left' | 'right';
  /** Skipped entirely when the session lacks it. Same set the sidebar filters on. */
  permission?: PermissionKey;
  /** Rendered as a hint chip in the bubble, e.g. 'alt+g'. */
  shortcut?: string;
  /** Pressing this key advances the step instead of only Next. */
  advanceOn?: string;
  /** What to do on a phone when there is no mobileAnchor. */
  mobile?: 'skip';
  /** Opens this overlay before drawing, e.g. the account menu. */
  requires?: 'account-menu';
}
```

Three registries export from one file: `MAIN_TOUR`, `MINI_TOURS`
(`Record<string, GuideStep[]>`), and `REGISTRY_VERSION`.

**Why a registry rather than steps declared on each screen:** a step declared
inside `punch-page.tsx` only exists once that route has mounted, so the Guide
could not know the tour's length, could not show "9 of 14", and could not skip
a block before navigating into it. One list also means the whole tour is
reviewable in one file.

---

## 6. The highlight, and how it moves

This is the only genuinely new UI mechanism, so it is specified precisely.

**No tour library.** driver.js, react-joyride and shepherd all inject their own
DOM and their own stylesheet. That breaks CLAUDE.md §3 rule 1 (every component
from shadcn) and the styling rule (Tailwind plus theme tokens only), and it is
a dependency that needs approval. None is needed.

**Composition, from primitives already installed:**

| Part | Built from |
|---|---|
| Bubble, desktop | `ui/popover` (Base UI) via a new `shared/anchored-popover` |
| Bubble, phone | `ui/sheet`, `side="bottom"` |
| Closing card | `ui/dialog` |
| Buttons, chips | `ui/button`, `shared/shortcut-hint` |
| Progress | `ui/progress` |
| Scrim + cutout | One `<div>`, Tailwind, theme tokens |

**The one missing primitive.** `ui/popover.tsx` forwards only
`align | alignOffset | side | sideOffset` to Base UI's `Positioner`, so it can
only anchor to a `PopoverTrigger` it wraps. The Guide has to anchor to an
element it does not own. Base UI's `Popover.Positioner` already accepts an
`anchor` prop; the wrapper simply does not pass it through.

Fix per CLAUDE.md §3 — compose, do not edit the shadcn file, because the next
`shadcn add` overwrites it:

```
components/shared/anchored-popover.tsx
```

A thin composition over the same `@base-ui/react/popover` primitives that
forwards `anchor`. No copied source, no new dependency. It earns its place in
`shared/` because a "point at this element" popover is reusable — a field-level
validation callout wants the same thing.

**The scrim.** A single fixed element with a hole over the anchor's measured
rect:

```
position: fixed; inset: 0; z-index: 40;
top/left/width/height  = anchor rect, inflated by 4px
box-shadow: 0 0 0 9999px var(--scrim);
outline: 2px solid var(--ring);
pointer-events: none;
border-radius: 0;   /* --radius is 0; a rounded cutout on a square app is wrong */
```

Notes that matter:

- `pointer-events: none` on the scrim, with a separate full-screen click-catcher
  *behind* it at z-index 39 that advances the step. The highlighted control
  stays genuinely clickable — the tour never traps anyone.
- The rect is tracked with a `ResizeObserver` on the anchor plus a passive
  `scroll` listener on the capture phase, both throttled to `requestAnimationFrame`.
  A sticky header and a scrolling table both move things under the cutout.

### 6.1 Motion

The Guide is the one surface in this application that is allowed to animate
properly, and the reason is worth stating because it is the opposite of the
call made everywhere else in the shell.

Go To and the shortcut sheet carry `.surface-instant` — no entrance at all —
because a Tally user opens them dozens of times a day and motion on something
that frequent is felt as latency, not craft. **The tour is the inverse: most
people see it once.** It is the rare, first-time surface where motion earns its
place, and where it is doing real work — the cutout sliding from one control to
the next is what tells the eye *these two things are related and we moved
between them*. A cut would leave the reader re-finding the highlight on every
step.

So the frequency test says animate, and the following is the specification.

**Curves.** The built-in CSS easings are too weak to read as intentional. Two
custom curves, defined once alongside the existing theme tokens:

```css
--ease-out:    cubic-bezier(0.23, 1, 0.32, 1);      /* things arriving */
--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);     /* things moving on screen */
```

`ease-in` appears nowhere. It delays the first few frames — exactly the moment
the reader is watching hardest — so it reads as sluggish at any duration.

**The table.**

| What | Property | Duration | Curve | Why |
|---|---|---|---|---|
| Cutout moving between two anchors on the same screen | `top`, `left`, `width`, `height` | 240ms | `--ease-in-out` | On-screen movement, not an entrance. It accelerates and settles like a real object |
| Bubble entering | `opacity`, `transform` | 200ms | `--ease-out` | From `scale(0.96)`, never `scale(0)` — nothing in the world appears out of nothing |
| Bubble leaving | `opacity`, `transform` | 140ms | `--ease-out` | Exit is faster than entry. The reader has already decided; the system should get out of the way |
| Bubble content swapping in place | `filter: blur(2px)`, `opacity` | 160ms | `ease` | Only when the bubble does not move. See below |
| Scrim opacity on first appear / final dismiss | `opacity` | 200ms / 140ms | `--ease-out` | The tour arriving and leaving, once each |
| Next / Back / Skip on press | `transform: scale(0.97)` | 120ms | `--ease-out` | The button has to feel like it heard the press |
| Unread dot on the avatar | `opacity`, `transform` | 200ms | `--ease-out` | Appears once per release. From `scale(0.8)`, no bounce |

Nothing exceeds 300ms. The bubble is `transform` and `opacity` only, so it
stays off the main thread; the cutout has to animate `top`/`left`/`width`/`height`
because a box-shadow hole cannot be expressed as a transform, and it is one
element with no children, which is what makes that acceptable.

**Origin.** The bubble scales from the control it points at, not from its own
centre. `ui/popover.tsx` already sets `origin-(--transform-origin)` and Base UI
already computes it, so this costs nothing — it just must not be overridden.
The closing card is the exception and keeps a centred origin, because a Dialog
is anchored to the viewport rather than to any trigger.

**Transitions, not keyframes.** A reader who has decided to skim will hammer
Next. Keyframes restart from zero on every re-trigger and the cutout would
stutter between anchors; transitions retarget from wherever the element
currently is and stay smooth. This is the same reason Sonner uses transitions
for stacked toasts, and it is the single most likely thing to be got wrong here.

**Two kinds of step change, deliberately different.**

- *Same screen, a nearby anchor* — the cutout slides, the bubble slides with it,
  and only the text swaps. The swap crossfades under a 2px blur, because a plain
  crossfade shows two legible strings overlapping for 80ms and reads as a
  rendering fault rather than a transition.
- *A route change* — the bubble fades out (140ms), the navigation happens, the
  new anchor is found and scrolled to, the cutout appears at its new home with
  no travel, and the bubble fades in. Sliding a cutout across a screen that has
  been replaced underneath it is a lie about continuity that was never there.

**Scrolling to an off-screen anchor.** `scrollIntoView({ block: 'center',
behavior: 'smooth' })`, and the cutout does not move until the scroll settles —
animating the hole while the page is also moving produces two competing motions
and the eye tracks neither.

**Reduced motion means gentler, not none.** The distinction matters: motion
sickness is caused by movement, not by opacity.

| Under `prefers-reduced-motion: reduce` | |
|---|---|
| Removed | Cutout travel, bubble travel, `scrollIntoView` smoothing, the press scale |
| Kept | Opacity on the bubble and the scrim, at 150ms |

The cutout jumps to its new rect; the bubble crossfades in place. The tour is
still comprehensible, which is what the opacity is there for. `.surface-instant`
is deliberately *not* used — that class means "no motion because this is
frequent", which is a different reason and would strip the fade too.

**On a phone.** The Sheet enters from the bottom edge and leaves through the
same edge, so a downward swipe to dismiss feels like the direction the thing
already came from. Dismissal is velocity-based rather than distance-based — a
quick flick past roughly `0.11 px/ms` ends the tour without needing to drag the
sheet most of the way down — and the drag is damped past its boundary rather
than hard-stopped.

**Hover states** are gated behind `@media (hover: hover) and (pointer: fine)`,
or a tap on a phone leaves the tour's Next button stuck in its hover state.

**When the anchor is not there.** The Guide navigates, then polls for the
anchor via `MutationObserver` with a 1500ms ceiling. If it never appears:

- **Production:** the step is skipped silently, the counter adjusts, the run
  continues. A missing anchor must never strand somebody mid-tour.
- **Development:** the same skip, plus a `console.error` naming the step id and
  the anchor. A silent skip in dev is how a tour rots without anybody noticing.

---

## 7. Anchors, and the one real ongoing cost

A step finds its target through a data attribute on the real control:

```tsx
<Button data-guide="header.goto" variant="outline" size="sm" onClick={toggleGoto}>
```

One attribute. No wrapper element, no ref plumbing, no change to the component's
behaviour or layout.

**The cost is drift.** Refactor a screen, drop the attribute, and the step
vanishes with no error in production. This is the honest liability of the whole
design, and it needs the CLAUDE.md "make the class impossible" treatment rather
than discipline:

1. **A registry test.** `guide.test.ts` renders the shell and every routed
   screen under a permission set that grants everything, and asserts every
   `anchor` and `mobileAnchor` in the registry resolves to exactly one element.
   It fails in CI the moment an attribute is deleted or duplicated.
2. **A dev-time assertion** on step entry, as above.
3. **A lint-visible naming convention** — `area.control`, e.g. `header.goto`,
   `nav.group.work`, `punch.capture` — so an attribute is obviously load-bearing
   to somebody reading the JSX.

Item 1 is the one that actually works. Without it this feature quietly decays.

---

## 8. Keyboard

The Guide pushes a shortcut layer, which suspends the underlying screen's keys
exactly as a modal does — the registry already supports this:

```tsx
<ShortcutLayer id="modal:guide">
```

| Key | Action |
|---|---|
| `Enter` / `→` | Next step |
| `←` | Previous step |
| `Esc` | Stop, and record where |
| `Ctrl+Q` | Stop — the Tally "quit screen without saving" key, and it should mean the same thing here |
| The step's own `advanceOn` | Performs the real action and advances |

No new global shortcut is registered. The Guide is reached from the shortcut
sheet and the account menu, both of which already exist.

Focus moves to the bubble on each step, with `aria-live="polite"` on the body,
so the step is announced rather than only drawn. Focus returns to the element
that opened the run when it ends.

---

## 9. Updates — the screen

**Route:** `/updates`, off the sidebar, reached from the account menu.

PRD §6.1 fixes the sidebar to Work, Records, Reports and Setup. A changelog
belongs to none of them, so it takes the same treatment `/profile` already
takes: added to `OFF_NAV_LABELS` in `lib/nav.ts` so the breadcrumb can name it,
and never added to `NAV_GROUPS`. That is a one-line change to an existing map
that was built for exactly this case.

**Data:** a typed module, not an API.

```ts
export interface ChangelogEntry {
  kind: 'added' | 'changed' | 'fixed';
  title: string;
  body: string;
  reqs?: string[];      // REQ-E-09 — already in every commit message
  route?: string;       // "Take me there"
  tour?: string;        // "Show me" — a MINI_TOURS key
  permission?: PermissionKey;   // hidden from people who cannot use it
}

export interface Release {
  version: string;
  date: string;         // ISO
  entries: ChangelogEntry[];
}
```

**Why not an API:** it changes when the code changes, it ships with the code,
and it is the same in every environment. A table, a migration and an endpoint
would buy nothing and would let production and the bundle disagree.

**Layout**, following PRD §6.2 and the no-box-in-box rule: page header, then
one release per section — version and date as a `SectionHeading`, entries as
rows separated by dividers, `kind` as a `Badge`. No cards. Long histories
paginate with the existing `record-pagination`, newest first.

**Empty state:** `ui/empty`, "No updates yet."

**Permission filtering:** an entry gated on a permission the person lacks is
hidden. Announcing a Roles change to somebody who cannot open Roles is noise,
and pointing "Show me" at a screen they will be refused is worse.

---

## 10. Persistence

**Now: `localStorage`, via `zustand/persist`** — the same shape and the same
reasoning as `nav-preferences-store.ts`, which already sits beside it.

```ts
interface GuideState {
  completedAt: string | null;
  dismissedAt: string | null;
  lastStepId: string | null;
  registryVersion: number | null;
  seenVersion: string | null;      // newest Updates release read
  completedMiniTours: string[];
}
```

Key: `vyuha.guide`.

Cost of being wrong: a tour offers itself a second time on a new browser. That
is the whole downside, and it does not justify a table.

**Later, if wanted:** move to a `user_preferences` row on the server so it
follows the person across devices. The store is the only seam; nothing else
changes. That is a migration plus one endpoint, and it is not needed to ship.

---

## 11. Copy

PRD §6.6 governs, without exception: plain, active, sentence case. No
exclamation marks, no emojis, no apologising interface. CLAUDE.md §3 rule 2
forbids emojis everywhere including seed data, and changelog entries are seed
data in every sense that matters.

Concretely, for the tour:

- Say what the control does, not that it exists. "Press Alt+G anywhere and type
  the first few letters of a screen" — not "This is the Go To button."
- Two sentences maximum per step. A third sentence means the step should be two
  steps or the UI needs a better label.
- Never "simply", "just", "easy", or "don't worry".
- The button says `Next`, not `Next →`. Icons come from the icon set, not from
  characters.

---

## 12. Files, and everything this touches

**New — 11 files, entirely additive:**

```
apps/web/src/features/guide/
  guide-overlay.tsx        The scrim, cutout, bubble, and the run loop
  guide-bubble.tsx         Popover above 768px, Sheet below
  guide-invitation.tsx     The first-sign-in offer
  tour-steps.ts            MAIN_TOUR, MINI_TOURS, REGISTRY_VERSION
  use-guide-run.ts         Navigate, wait for anchor, measure, advance
  guide.test.ts            Every anchor resolves to exactly one element
  index.ts

apps/web/src/features/updates/
  updates-page.tsx
  changelog.ts
  index.ts

apps/web/src/components/shared/anchored-popover.tsx
apps/web/src/lib/guide-store.ts
```

**Modified — 4 files, 6 lines of logic between them:**

| File | Change |
|---|---|
| `App.tsx` | One `<Route path="updates">`; wrap `<Outlet>` region with `<GuideProvider>` |
| `app/layout/app-shell.tsx` | Mount `<GuideOverlay />` beside `<GoToPalette />`; add two rows to the account menu (Updates, Take the tour) and the unread dot |
| `lib/nav.ts` | One line: `'/updates': 'Updates'` in `OFF_NAV_LABELS` |
| `app/shortcut-dialog.tsx` | A "Take the tour" button in the footer |

**Annotated — attribute only, no logic:** roughly 22 elements across
`app-sidebar`, `app-shell`, `mobile-bottom-nav`, and one control on each of
Punch, My attendance, My leave, Team attendance, Approvals, Reports, Downloads,
Employees, Shifts, Leave types, Holidays, Settings, Roles, Period lock, Audit.

**Not touched at all:**

- `apps/api` — no controller, service, repository, route or migration
- `packages/shared` — no contract change
- Every domain service, every query, every permission definition
- Any existing component's props, styling, layout or behaviour

**Dependencies added: none.** Base UI, zustand, react-router, the shadcn
primitives and the Phosphor icon set already cover all of it.

---

## 13. Does this impact current development?

**Short answer: no, with one qualification worth naming.**

What makes it safe:

- No migration, no schema change, no API. The whole feature is client-side.
- No shared contract changes, so nothing in `apps/api` recompiles differently.
- The four modified files take additive edits — a route, a mount, a map entry,
  a button. No existing code path changes behaviour.
- The overlay renders `null` unless a run is active, so the shipped cost when
  nobody is taking the tour is one mounted component doing nothing.
- Work can be interleaved. Nothing in flight — the employee import in
  `apps/api/src/platform/people/` — shares a file with any of this.

**The qualification, stated plainly:** the `data-guide` attributes are a
coupling between the registry and the JSX of 22 screens. It is a weak coupling —
an attribute, not a structure — but it is real, and it is the one thing here
that will decay if left unattended. A screen refactored six months from now
drops an attribute and the step disappears with no error in production. The
registry test in §7 is what converts that from a slow rot into a red CI run,
and it is not optional. If the test is skipped, do not build this.

**Sequencing recommendation:** the tour describes screens, so it is worth
writing when the screens have stopped moving. Phase 5 (polish and hardening) is
its natural home. The attributes are the exception — those are free to add
opportunistically as each screen is touched, well before the Guide exists,
because an unused data attribute costs nothing.

Updates has no such dependency and could ship on its own at any point. It is
also the half that pays off immediately, because it is the only place a release
currently gets explained to anybody.

---

## 14. Open questions

Mirrored into `OPEN-QUESTIONS.md`. Each states the default in use if it is
built before an answer arrives.

| # | Question | Default |
|---|---|---|
| G-1 | Auto-start on first sign-in, or offer and wait? | **Offer.** A shop-floor punch user should not have their first sign-in taken over. |
| G-2 | One permission-filtered tour, or a distinct tour per role? | **One registry, permission-filtered.** It cannot disagree with the sidebar, and a new role needs no new tour. |
| G-3 | Seen-state per device or per user? | **Per device (`localStorage`).** Server-side is one endpoint away if wanted. |
| G-4 | Is `/updates` as an off-sidebar route acceptable against PRD §6.1? | **Yes, same treatment as `/profile`.** Says so here rather than editing the PRD unasked. |
| G-5 | Does a release note ever need to interrupt (a breaking change, a policy change)? | **No interruption of any kind.** If a "must read" tier is wanted, that is a different design and should be said now. |
| G-6 | Which phase? It is in no phase of `03-scope-and-delivery-plan.md`. | **Phase 5**, with anchors added opportunistically from now. |
| G-7 | Who writes the changelog copy? | **Whoever closes the phase**, from the REQ IDs already in the commit messages. |

---

## 15. Definition of done

Beyond CLAUDE.md §4, which applies unchanged:

- [ ] `guide.test.ts` resolves every anchor in every registry to exactly one
      element, and fails when an attribute is removed
- [ ] Verified at 360px: the bubble is a Sheet, the highlight is visible above
      it, footer targets are 44px
- [ ] Verified with `prefers-reduced-motion: reduce`: no cutout travel, no
      bubble travel, no smooth scroll, no press scale — and the opacity fades
      still present, because reduced motion is gentler, not none
- [ ] Motion reviewed at 4x slow-motion in the DevTools animation panel, and
      again the following day. Specifically: the cutout does not stutter when
      Next is hammered, the bubble scales from the control rather than from its
      own centre, and the text swap shows one string rather than two overlapping
- [ ] Verified under three permission sets — punch-only, manager, admin — that
      no step points at a control the session cannot see
- [ ] Verified that the highlighted control is genuinely clickable mid-run, and
      that `Esc` always exits
- [ ] Verified a mini-tour launched from an Updates row navigates, runs, and
      returns
- [ ] Zero new dependencies in `apps/web/package.json`
- [ ] Zero changes under `apps/api` and `packages/shared`
