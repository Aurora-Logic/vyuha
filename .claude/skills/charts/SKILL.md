---
name: charts
description: How Vyuha draws every chart - plain shadcn ChartContainer over Recharts, square and slim, coloured only in shades of the workspace accent, with the series and every insight sentence in a tested module. Use whenever adding, changing or reviewing a chart, a KPI tile, or anything that renders a figure as a picture.
---

# Charts

One approach, everywhere. A chart added in a year must be indistinguishable
from the ones on `/reports/dashboard` today.

The reference implementation is
`apps/web/src/features/reports/dashboard-v2.tsx` and its series module. Read
it before writing a new chart; copy its shape rather than inventing one.

## 1. Plain shadcn, and nothing on top of it

Charts are the shadcn chart examples, used as shadcn ships them: a `Card`, the
`ChartContainer` primitive at `apps/web/src/components/ui/chart.tsx`, and
Recharts shapes. Reach for `mcp__shadcn__get_item_examples_from_registries`
with `chart` and start from the example.

There is no house chart layer. The old `/vyuha-charts` skill mandated one --
shared label-prop factories, a draw-once motion hook, a `ChartPanel` surface --
and it is retired. Do not reintroduce it, and do not add a wrapper "so the
next chart is easier": the next chart is easier because it copies an example.

No second charting library. No hand-rolled SVG.

## 2. Square and slim

The theme is square: `--radius` is 0 and base-lyra uses `rounded-none`
throughout. A rounded bar is the only curve on the page and it looks like a
mistake.

- Bars: `radius={0}`, or omit the prop.
- `maxBarSize`: **16** for columns, **12** for a plain horizontal bar,
  **26** for a horizontal bar with its name written inside it, **24** for a
  single full-width composition band.
- Never leave a `<Bar>` with no cap. Recharts fills the whole band and the
  result reads as a block of colour rather than a measurement.

**A label inside a bar sets that bar's minimum height.** 12px is thinner than
11px text, so a long name wraps to two lines and both are clipped. If the bar
carries an inside label it is 26, or the label goes outside.

## 3. Colour comes from the accent, and only from the accent

Use `var(--chart-1)` through `var(--chart-5)`. Never a hex, never an `oklch()`
literal, never a Tailwind palette colour in a chart.

Those five tokens are **five shades of the workspace's accent hue** -- deepest
at slot 1, lightest at slot 5 -- derived in `apps/web/src/index.css` from
`--accent-h` and `--accent-c`, which the appearance picker sets. A chart in a
crimson workspace is crimson.

They are not five different hues. That was tried: rotating the hue to make
five distinguishable colours meant a crimson workspace drew green and teal
slices, which is not the colour anyone chose.

- Single series: `--chart-1`.
- An ordered scale (age buckets, a heatmap): the slots in order, so the ramp
  reads as a ramp.
- Categorical series: the slots in fixed order, never cycled, and always with
  a legend plus direct labels, because five shades of one hue separate by
  lightness and the legend is what names them.

**Status colours are reserved.** `--success`, `--warning`, `--destructive`,
`--info` mean a state, not a series. Attendance status charts and the flag
tokens use them deliberately and must not be swept into the accent ramp. The
`--tint-1..8` identity palette is for avatars and kanban columns, not charts.

If you touch the ramp: every change is validated, not eyeballed. Run the
`dataviz` skill's `scripts/validate_palette.js` over all eighteen accent
presets in both light and dark, and report the pass count.

## 4. The figure is on the mark

Every mark carries its value without hovering -- a `LabelList` on the bar cap,
at the end of the horizontal bar, on the slice. Two or more series always get
a legend, so identity is never colour alone. Text wears text tokens
(`fill-foreground`, `fill-background`, `text-muted-foreground`), never a
series colour.

Money uses `formatMoney` in prose and footers and `formatMoneyShort` on a
mark or an axis tick; both come from `@/lib/format` and both read the
workspace's currency symbol. Never write a currency symbol as a literal.

## 5. The arithmetic lives where it can be tested

A Recharts chart cannot be rendered in jsdom. So nothing that can be got wrong
may live in the `.tsx`:

- Series builders and insight sentences go in a sibling `*.series.ts`, pure
  over the API rows.
- Every threshold an insight turns on is a named exported constant, and every
  one has a test.
- Tests cover the empty case, the single-point case, and the case the
  threshold sits on.
- Formatters that produce axis or label text go in a `*.format.ts` with tests.
  `label.slice(0, 3)` on `"2026-07"` shipped as `"202"` because nobody could
  render the axis to look at it.

Reports are sorted by their own default -- `sales-analysis` is `-value` -- so
a time axis must sort by key itself. Do not assume the API's order is the
chart's order.

## 6. Layout traps that have cost time

- **Never put `flex` on the `CardContent` holding a chart.** `ChartContainer`
  measures itself through a Recharts `ResponsiveContainer`; a flex child with
  no basis resolves to zero width and the card renders a correct header and
  footer around nothing. Centre with `mx-auto` on the container.
- Every chart needs an empty, a loading and an error state. The loading state
  is a skeleton shaped like the chart, so the page does not jump.
- A chart is on the card surface. No card inside a card (CLAUDE.md section 3).
- shadcn's own examples use a raw `<button>` in places. This project does not
  allow one in feature code -- use the `Button` primitive with the same
  classes.

## 7. Before calling it done

- `pnpm --filter @vyuha/web run build` -- this runs `tsc -b`, which catches
  what `tsc --noEmit` does not.
- `pnpm --filter @vyuha/web exec eslint <files>`
- `pnpm --filter @vyuha/web run test`
- The series verified against real rows from the running API, not fixtures
  alone: a wrong cell key returns `undefined`, reads as `0`, and draws a chart
  that is quietly false.
- 360px and 1920px, both themes.
