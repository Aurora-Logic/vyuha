import type { DashboardTileForm, ReportDefinition, ReportKey } from '@vyuha/shared';
import type { DateRange } from 'react-day-picker';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { cn } from '@/lib/utils';

import { useReportRows } from './api';
import { FORM_LABELS } from './dashboard-form-labels';
import { periodParams } from './period';
import { GenericReportChart } from './report-charts';
import { formDraws, resolveChartForm, wearableForms, type ChartRow } from './report-series';

/**
 * The chart picker as a gallery of the charts themselves (owner, 25 Aug 2026:
 * "every type visible WITH live preview"). A name like "Pareto" asks the
 * person to already know what a Pareto is; the report's own rows drawn in
 * every form it can wear asks them only to look. Each tile is the real chart
 * renderer over the real rows, so what is picked is exactly what the board
 * will draw.
 */

interface GalleryEntry {
  readonly form: DashboardTileForm;
  readonly caption: string;
  /** On the Automatic tile only: the form the resolver would pick for these rows. */
  readonly badge?: string;
  /** Why this tile has no picture, stated on the tile rather than by hiding it. */
  readonly note?: string;
  readonly dimmed: boolean;
  readonly preview: boolean;
}

function galleryEntries(
  reportKey: ReportKey,
  definition: ReportDefinition,
  rows: readonly ChartRow[],
): GalleryEntry[] {
  const resolved = resolveChartForm(reportKey, definition, rows);
  const hasRows = rows.length > 0;
  return [
    {
      form: 'auto',
      caption: FORM_LABELS.auto,
      // With no rows and no override the resolution is unknown, and a badge
      // reading "Table" would state as fact what cannot yet be known.
      ...(resolved === null
        ? hasRows
          ? { badge: 'Table', note: 'reads as a table' }
          : {}
        : { badge: FORM_LABELS[resolved.form] }),
      dimmed: false,
      preview: hasRows && resolved !== null,
    },
    ...wearableForms(definition).map((form): GalleryEntry => {
      const draws = hasRows && resolved !== null && formDraws({ ...resolved, form }, definition, rows);
      const dimmed = hasRows && !draws;
      return {
        form,
        caption: FORM_LABELS[form],
        // Dimmed, never hidden: the columns can wear this form even though
        // these particular rows cannot, and a vanishing option reads as a bug.
        ...(dimmed ? { note: 'needs different columns' } : {}),
        dimmed,
        preview: draws,
      };
    }),
  ];
}

/**
 * The presentational half, taking rows directly so a test can feed it a
 * fixture page without standing up the query layer. `FormGallery` below is
 * the only production caller and only adds the fetch.
 */
export function FormGalleryView({
  reportKey,
  definition,
  rows,
  form,
  onPick,
}: {
  reportKey: ReportKey;
  definition: ReportDefinition;
  rows: readonly ChartRow[];
  form: DashboardTileForm;
  onPick: (form: DashboardTileForm) => void;
}) {
  const entries = galleryEntries(reportKey, definition, rows);
  const hasRows = rows.length > 0;
  return (
    <div className="flex flex-col gap-2">
      {hasRows ? null : (
        <p className="text-muted-foreground border px-3 py-2.5 text-xs">
          No rows in this period to preview.
        </p>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {entries.map((entry) => (
          <Button
            key={entry.form}
            type="button"
            variant="outline"
            aria-pressed={entry.form === form}
            onClick={() => {
              onPick(entry.form);
            }}
            className="h-auto min-w-0 flex-col items-stretch gap-0 overflow-hidden p-0 text-left font-normal whitespace-normal aria-pressed:border-primary aria-pressed:ring-2 aria-pressed:ring-ring"
          >
            {hasRows ? (
              <span
                aria-hidden
                className={cn(
                  'pointer-events-none block h-40 w-full min-w-0 overflow-hidden border-b',
                  // The chart's own container is forced to the frame's house
                  // height, so the preview is the real chart drawn small
                  // rather than a full-size chart scaled or cropped.
                  '[&_[data-slot=chart]]:aspect-auto [&_[data-slot=chart]]:h-40 [&_[data-slot=chart]]:w-full',
                  entry.dimmed && 'bg-muted/30 opacity-50',
                )}
              >
                {entry.preview ? (
                  <GenericReportChart
                    reportKey={reportKey}
                    definition={definition}
                    rows={rows}
                    animate={false}
                    {...(entry.form === 'auto' ? {} : { form: entry.form })}
                  />
                ) : null}
              </span>
            ) : null}
            <span className="flex min-h-11 w-full flex-col justify-center gap-0.5 px-2 py-1.5">
              <span className="flex items-center justify-between gap-1">
                <span className="min-w-0 truncate text-xs font-medium">{entry.caption}</span>
                {entry.badge === undefined ? null : (
                  <Badge variant="secondary" className="shrink-0">
                    {entry.badge}
                  </Badge>
                )}
              </span>
              {entry.note === undefined ? null : (
                <span className="text-muted-foreground text-xs leading-tight">{entry.note}</span>
              )}
            </span>
          </Button>
        ))}
      </div>
    </div>
  );
}

/**
 * The gallery over one fetched page of the report's rows: fifty, not the
 * board's two hundred, because a dozen thumb-height previews render from this
 * one page and each only has room for its top rows anyway. Mounted only while
 * a tile's gallery is expanded, so a closed sheet fetches nothing.
 */
export function FormGallery({
  reportKey,
  definition,
  form,
  onPick,
  range,
}: {
  reportKey: ReportKey;
  definition: ReportDefinition;
  form: DashboardTileForm;
  onPick: (form: DashboardTileForm) => void;
  range: DateRange;
}) {
  const rows = useReportRows(reportKey, {
    page: 1,
    pageSize: 50,
    ...periodParams(reportKey, range),
  });

  if (rows.isPending) {
    // Each placeholder mirrors a real tile -- preview frame over caption
    // strip -- so the grid holds its height when the charts arrive.
    return (
      <div
        role="status"
        aria-busy="true"
        aria-label="Loading chart previews"
        className="grid grid-cols-2 gap-3 sm:grid-cols-3"
      >
        {['auto', ...wearableForms(definition)].map((form) => (
          <div key={form} aria-hidden className="flex flex-col border">
            <Skeleton className="h-40 w-full rounded-none" />
            <span className="flex min-h-11 items-center border-t px-2 py-1.5">
              <Skeleton className="h-3 w-16" />
            </span>
          </div>
        ))}
      </div>
    );
  }

  if (rows.isError) {
    return (
      <QueryErrorAlert
        error={rows.error}
        subject="the chart previews"
        onRetry={() => {
          void rows.refetch();
        }}
      />
    );
  }

  return (
    <FormGalleryView
      reportKey={reportKey}
      definition={definition}
      rows={rows.data.data}
      form={form}
      onPick={onPick}
    />
  );
}
