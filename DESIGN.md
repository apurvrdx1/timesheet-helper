# DESIGN.md — Timesheet Helper

## 1. Overview

**Product.** A single-user planning tool for a manager who allocates monthly CAPEX/OPEX
hours across their direct reports and produces submittable weekly timesheets.

**Audience.** One person — an engineering/digital manager — on a laptop, in focused
sessions, entering numbers and reading grids. Not a marketing surface. Not mobile.

**Design intent.** *Make the numbers legible and the exceptions loud.* Every pixel either
carries a figure or explains one. The interface should feel like a well-made internal
tool: quiet by default, emphatic exactly where something needs attention.

**Vibe.** Calm · precise · utilitarian · trustworthy · unfussy.

**Grounding.** Astryx (Meta) design system, `neutral` theme. Astryx components and tokens
are the default; this file records how *this* app uses them. Where Astryx is silent
(tabular figures, data-grid density, CAPEX/OPEX encoding), decisions below are marked
`(inferred)` and are binding for this project.

---

## 2. Foundations

### 2.1 Color

Astryx colors are **semantic** — tokens name a purpose, never an appearance — and adapt
between light and dark automatically via CSS `light-dark()`. Never hardcode a hex in
component code; always reference the token.

#### Surface hierarchy

| Token | Light / Dark | Use for |
|---|---|---|
| `--color-background-body` | `#f1f1f1` / `#1b1b1b` | The page itself. Never put text directly on it. |
| `--color-background-surface` | — | Primary content regions; the shell around tables. |
| `--color-background-card` | — | Cards, table containers, the week panels. |
| `--color-background-popover` | — | Dropdowns, tooltips, dialogs. Topmost layer only. |

Depth increases toward the viewer: body → surface → card → popover. **Never nest a card
inside a card** to create depth (see Anti-patterns).

#### Content

| Token | Use for |
|---|---|
| `--color-text-primary` | Hour figures, names, OTL codes — anything the user reads to decide. |
| `--color-text-secondary` | Column headers, units, row captions, helper text. |
| `--color-text-disabled` | Non-working days, zeroed cells, out-of-period dates. |
| `--color-text-accent` | Links and the active nav item only. Not for emphasis. |
| `--color-icon-primary` / `-secondary` / `-disabled` / `-accent` | Icons; match the adjacent text role. |

#### Structure

| Token | Use for |
|---|---|
| `--color-border` | Default table gridlines, input borders, dividers. |
| `--color-border-emphasized` | The boundary between a person's block and the next; header underline. |
| `--color-accent` | Primary buttons, focus rings, the override/lock marker. |
| `--color-accent-muted` | Selected row wash, active tab background. |

#### Status — the app's alarm system

| Token | Meaning in this app |
|---|---|
| `--color-success`, `--color-success-muted`, `--color-on-success` | A week balances exactly: 37.5h placed, OPEX floor met, no residual. |
| `--color-warning`, `--color-warning-muted`, `--color-on-warning` | Attention, not failure: unplaced hours carried forward, budget not fully handed out, stale results awaiting recalculation. |
| `--color-error`, `--color-error-muted`, `--color-on-error` | Invalid state: a day ≠ 7.5h, OPEX floor breached, a person over capacity. |

Status colors are for **state**, never decoration. A green figure means "this balances,"
not "this is a good number."

#### Category encoding (inferred)

The three OTL categories must be distinguishable at a glance without reading the code.

- **CAPEX** — assign each CAPEX OTL a color from the Astryx **categorical dataviz** ramp
  (`blue, orange, purple, green, pink, cyan, red, teal, brown, indigo`), allocated in
  order of first appearance and **stable for the life of the OTL** so a code keeps its
  color across weeks and months. Applied as a 3px left border on the OTL row and as the
  dot in the legend — never as a cell background, which would fight the status colors.
- **OPEX** — no categorical color. Neutral treatment with `--color-text-secondary` for the
  row label. OPEX is the background hum; it should recede.
- **Leave** — `--color-warning-muted` background across the whole day column, with the
  subtype as a `Badge`. Leave is an exception and should read as one.

Ten categorical colors is the ceiling; beyond that, cycle and rely on the code text. Never
invent colors outside the ramp.

### 2.2 Typography

| Role | Token | Value |
|---|---|---|
| Body / UI | `--font-family-body` | Figtree |
| Headings | `--font-family-heading` | Figtree |
| Code / OTL identifiers | `--font-family-code` | SF Mono |

**Scale.** Geometric, base 14px × 1.2^step, in rem:

`--font-size-4xs` 0.375 · `3xs` 0.4375 · `2xs` 0.5 · `xs` 0.625 · `sm` 0.75 ·
`base` 0.875 · `lg` 1.0625 · `xl` 1.25 · `2xl` 1.5 · `3xl` 1.8125 · `4xl` 2.1875 ·
`5xl` 2.625

**Weights.** `--font-weight-normal` 400 · `medium` 500 · `semibold` 600 · `bold` 700.

**Semantic styles** (size / weight / line-height) — prefer these over raw sizes:

| Style | Size | Weight | LH | Use here |
|---|---|---|---|---|
| H1 | 1.5rem | 600 | 1.3333 | Page title only, once per page. |
| H2 | 1.25rem | 600 | 1.4 | Section headings ("Reports", "Manager"). |
| H3 | 1.0625rem | 600 | 1.4118 | Week accordion headers. |
| H4 | 0.875rem | 600 | 1.4286 | Person name rows, table captions. |
| H5 | 0.75rem | 600 | 1.6667 | Column group headers. |
| Body | 0.875rem | 400 | 1.4286 | Default text and hour figures. |
| Label | 0.875rem | 500 | 1.4286 | Form labels, day-of-week headers, totals. |
| Code | 0.875rem | 400 | 1.4286 | Project / task / expenditure / TRC codes. |
| Supporting | 0.75rem | 400 | 1.6667 | Helper text, residual notes, units. |

Line-heights snap to a 4px vertical grid — do not override them; component heights depend
on it.

**Numerals (inferred, mandatory).** Astryx does not address tabular figures. Every numeric
cell, total, and budget figure **must** set `font-variant-numeric: tabular-nums`. Columns of
hours that don't align vertically are the single fastest way to make this app feel broken.

**Hour formatting.** Always one decimal place: `7.5`, `2.0`, `15.0`. Never `7.50`, never
bare `7`. Render a zero as an em-dash in `--color-text-disabled`, not `0.0` — a grid full
of zeroes is unreadable noise.

**Codes.** Project/task/expenditure/TRC codes use the `Code` style in `--font-family-code`.
They are identifiers, not prose, and monospacing makes mistyped digits visible.

### 2.3 Spacing & layout

**Base unit 4px.** `--spacing-0` … `--spacing-12` spanning 0 → 48px.

| Step | Use |
|---|---|
| `--spacing-1` / `-2` | Inside a cell; gap between a figure and its badge. |
| `--spacing-3` | Table cell padding (horizontal). |
| `--spacing-4` | Card padding; default gap in a `Stack`. |
| `--spacing-6` | Between a table and its heading. |
| `--spacing-8` | Between major sections on a page. |
| `--spacing-12` | Page top padding; between the two page-level regions. |

**Density — comfortable, not compact (inferred).** Table rows are **40px** tall with
`--spacing-3` horizontal cell padding. Do not shrink to a 28–32px "dense" grid: the user
asked for something easy to navigate on a laptop, and hour cells are edit targets, not
just readouts. A 13" laptop should show roughly a full week for one person without
vertical scrolling inside the panel.

**Layout.** Laptop-first, single column, `max-width: 1440px`, centered, with
`--spacing-8` gutters. Tables scroll horizontally inside their own container — the page
body must never scroll sideways. The four OTL identifier columns are **sticky-left** so
Mon–Fri scroll against a fixed row identity.

**Breakpoints.** Optimize for ≥1280px. Remain usable to 1024px. Below that, allow honest
horizontal scrolling rather than a reflow that hides columns — a timesheet with hidden
days is worse than one you scroll.

Use Astryx `Stack` / `HStack` / `VStack` / `Grid` / `Section` for all layout. No bespoke
flexbox wrappers.

### 2.4 Radius, border, elevation

| Token | Value | Use |
|---|---|---|
| `--radius-none` | 0 | Table cells. Cells never round. |
| `--radius-inner` | 8px | Inputs, badges, buttons. |
| `--radius-element` | 12px | Cards, banners, week panels. |
| `--radius-container` | 16px | The outer table container. |
| `--radius-page` | 32px | Page-level shell, if used at all. |
| `--radius-full` | 9999px | Status dots and pills only. |

**Elevation.** `--shadow-low` for resting cards; `--shadow-med` for dropdowns and popovers;
`--shadow-high` for dialogs only. Inset variants (`hover`, `selected`, `success`,
`warning`, `error`) carry cell state — prefer an inset shadow over a background fill for a
focused or invalid cell, so the figure inside stays legible.

Structure comes from **borders**, not shadows. A table is defined by `--color-border`
gridlines; it gets no drop shadow.

### 2.5 Motion

Durations sit in fast / medium / slow bands (130ms–1300ms). Easing is
`--ease-standard: cubic-bezier(0.24, 1, 0.4, 1)`.

- **Fast** — hover, focus, badge appearance, button press.
- **Medium** — accordion expand/collapse, banner enter/exit, toast.
- **Slow** — never, in this app.

**What must not animate:** hour figures changing after a recalculation. No count-up, no
cross-fade, no row-shuffle transition. The user compares before and after; movement makes
that harder and implies the number is uncertain. Changed cells may receive a **static**
inset highlight that clears on the next interaction.

Respect `prefers-reduced-motion`: drop to instant state changes.

---

## 3. Components

Reach for the Astryx component first — all of these exist. Do not hand-roll.

### Table (`Table`, `TableHeader`, `TableBody`, `TableRow`, `TableCell`)
The core of the app. Header row uses `Label` style, `--color-text-secondary`, with a
`--color-border-emphasized` underline. Rows separate with `--color-border`. Sticky-left OTL
identifier columns; a totals row per person, `Label` weight, separated by
`--color-border-emphasized`.
**Rule:** every hour column is right-aligned with tabular numerals; every text column is
left-aligned. No centered numbers, ever.

### Editable hour cell (composed: `TableCell` + `NumberInput`)
States — **calculated** (plain text, `--color-text-primary`); **hover** (inset hover
shadow, cursor text); **focused** (accent focus ring, `NumberInput` active, step 0.5);
**overridden/locked** (3px `--color-accent` left border + lock icon at
`--font-size-xs`, with a `Tooltip` reading "Manually set — recalculation will preserve
this"); **invalid** (inset error shadow); **zeroed by leave** (em-dash,
`--color-text-disabled`, not editable).
**Rule:** the lock marker must be visible without hover. A user scanning a week has to see
instantly which figures the optimizer is allowed to move.

### Collapsible / CollapsibleGroup
The Week 1–5 accordion. Header carries the week's date range, a capacity summary
(`37.5h`, or `30.0h` when a stat day falls inside), and a status dot — success when the
week balances, warning when it carries residual, error when it doesn't sum. Multiple weeks
open at once; state persists across reloads.
**Rule:** the header must convey whether the week needs attention while collapsed.
Expanding to find out is a failure.

### Banner
The recalculation CTA. `warning` variant, pinned below the page header, with body text
naming *what* went stale ("Allocations changed for September — results are out of date")
and a primary **Recalculate** action. Also used for unplaced hours carried forward.
**Rule:** one banner at a time. Merge concurrent messages rather than stacking them.

### Badge / Token
Leave subtypes (Vacation, Stat, Personal, Sick), category tags (CAPEX / OPEX / Leave), and
the "carried forward" marker. `--radius-inner`, `Supporting` size.
**Rule:** a badge states a fact. Never make one a button.

### NumberInput
Allocation entry and cell editing. Step 0.5, min 0, one decimal. Non-multiples of 0.5 are
accepted but flagged with `Supporting` helper text in `--color-warning` naming the residual.
**Rule:** never block typing. Validate on blur, explain in text, never silently round.

### DateRangeInput
Vacation and leave ranges. Weekends and existing stat holidays are disabled in the picker.

### Button / ButtonGroup / IconButton
Primary (accent, filled) for Recalculate and Save — **at most one per view**. Secondary for
Add OTL, Add Report, Export. Icon buttons for row-level revert and delete, each with a
`Tooltip`; an icon button never appears without one.

### Dialog / AlertDialog
`AlertDialog` for destructive confirmation only — deleting a person or OTL that has hours
against it, and clearing all overrides for a week. `Dialog` for add/edit forms using
`FormLayout`.
**Rule:** recalculation never opens a dialog. It's reversible and frequent; a banner and a
button are enough.

### Toast
Transient confirmations: saved to Sheet, export complete, recalculation finished. Never for
errors that need a decision — those are Banners.

### Selector / DropdownMenu
Month picker, OTL category, person filter. Use `Selector` for a bounded set,
`DropdownMenu` for actions.

---

## 4. Voice & content

**Tone.** Plain, specific, unhurried. Address the user directly. State what happened and
what to do next. No exclamation marks. No "Oops."

**Capitalization.** Sentence case everywhere — headings, buttons, labels, table headers.
Exceptions: `CAPEX`, `OPEX`, `OTL`, `TRC` are always uppercase; a code is written exactly
as entered.

**Numbers.** Hours to one decimal with an `h` suffix in prose (`15.0h`) and bare in table
cells. Percentages as whole numbers (`40%`). Ranges with an en-dash (`Mon–Fri`, `Sep 14–18`).

**Dates.** Short form in headers: `Mon 1 Sep`. Ranges: `31 Aug – 4 Sep 2026`. Weeks are
always labelled by date range, never by number alone — "Week 1" without dates is ambiguous
when weeks straddle months.

**Empty states.** Name the next action, not the absence.
Good: "Add your first OTL to start allocating hours."
Bad: "No data available."

**Errors.** Name the constraint and the actual figures.
Good: "Tuesday totals 8.0h — a day can hold 7.5h. Reduce one entry by 0.5h."
Bad: "Invalid input."

**Warnings.** State the quantity and where it went.
Good: "42.0h of P-1001 couldn't be placed this month. Carried forward to October."

**Loading.** This app computes locally and in milliseconds. Use no spinner for
recalculation. Only Google Sheet sync gets a loading state, and it's a `Toast`, not a
blocking overlay.

---

## 5. Decision rules

1. **Astryx component first.** If it exists in `@astryxdesign/core`, use it. Compose from
   primitives before writing custom CSS. Custom CSS is a last resort and needs a comment
   saying why.
2. **Token, never literal.** No hex codes, no px values outside the spacing scale, no
   font sizes outside the type scale in component code.
3. **Borders define structure; shadows define layer.** A thing that sits on the page gets a
   border. A thing that floats above it gets a shadow.
4. **Status color means state.** Never use success/warning/error decoratively, and never
   use accent to mean "good."
5. **Numbers right-aligned, tabular, one decimal.** Non-negotiable in every table.
6. **The exception is louder than the rule.** A normal 2.5h cell is quiet text. An override,
   a leave day, a breach of the OPEX floor, an unplaced residual — each has a distinct,
   immediately visible treatment.
7. **One primary action per screen.** Everything else is secondary or tertiary.
8. **Nothing important is hover-only.** Locks, statuses and warnings are visible at rest.
   Tooltips explain; they never reveal.
9. **Density is comfortable.** 40px rows. When in doubt, add space rather than remove it.
10. **Light and dark both ship.** Astryx handles it via `light-dark()` — never define a
    color that only works in one mode, and check every custom treatment in both.
11. **Keyboard is a first-class input.** This is a data-entry tool: Tab moves across a
    person's days, Enter commits, Escape reverts a cell to its calculated value.
12. **Focus is always visible.** Never remove the accent focus ring.

---

## 6. Anti-patterns — explicitly banned

- **Cards inside cards inside cards.** One card layer per region. A table in a card does
  not also get a card per person — use `--color-border-emphasized` to separate blocks.
- **Centered numbers** or proportional figures in any hour column.
- **`0.0` in empty cells.** Em-dash, disabled color.
- **Color-only encoding.** Every CAPEX color pairs with its code text; every status color
  pairs with a word or icon. Colorblind users must lose nothing.
- **Animated number changes** after recalculation — count-ups, cross-fades, row shuffles.
- **Drop shadows on tables**, or shadows used to suggest structure rather than layer.
- **Gradients**, anywhere. The neutral theme is flat by intent.
- **A compact 28px grid.** Explicitly rejected for this project.
- **Modal confirmations for reversible actions.** Recalculate, expand, edit a cell —
  none of these interrupt.
- **Emoji in the UI.** Use Astryx icons.
- **Spinners for local computation.**
- **Hiding columns on narrow screens.** Scroll instead.
- **Custom greens and reds** for CAPEX/OPEX categories that collide with the status
  palette. Categories use the dataviz ramp; status owns success/warning/error.
- **Bold as a general emphasis tool.** Weight signals hierarchy (headers, totals), not
  importance.

---

## 7. Provenance

- **Primary source:** Astryx design system by Meta — `https://astryx.atmeta.com/docs`
  (`/docs/getting-started`, `/docs/tokens`, `/docs/color`, `/docs/typography`,
  `/components`) and `https://github.com/facebook/astryx`. Theme: `neutral`.
- **Fidelity tier:** *free fallback* — `WebFetch` on key documentation pages. No Firecrawl
  key was present, so no full crawl; no Playwright pass was run, so interactive/hidden
  component states were not captured directly and the state definitions in §3 are
  reasoned from the token set rather than observed. Token names and the values quoted
  above are verbatim from the docs; component state styling should be verified against the
  live component gallery during implementation.
- **Marked `(inferred)`:** tabular numerals, row density, CAPEX/OPEX/Leave color encoding,
  hour and date formatting, keyboard model. These are project decisions, not Astryx
  doctrine, and are binding here.
- **Packages:** `@astryxdesign/core`, `@astryxdesign/theme-neutral`, `@stylexjs/stylex`,
  `@astryxdesign/cli` (dev). Requires React ≥19.
