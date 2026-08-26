import { useMemo, useState } from 'react';
import {
  ArrowClockwiseIcon,
  CheckCircleIcon,
  DownloadSimpleIcon,
  HourglassIcon,
  TrayIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react';
import { isToday, isYesterday, parseISO } from 'date-fns';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { PageHeader } from '@/components/shared/page-header';
import { SectionHeading } from '@/components/shared/section-heading';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Progress, ProgressLabel, ProgressValue } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { EXPORT_STATUS_LABELS, type ExportJobSummary } from '@vyuha/shared';
import { EMPTY_VALUE, formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';

import { FAMILY_TEXT, toneClasses, type Family } from '@/features/attendance/status';
import { useDownloadExport, useExportJobs } from './api';
import { describeExpiry, formatTimestamp } from './format';

/**
 * The Downloads tray: exports run as background jobs and land here with
 * progress and a 7-day retention.
 *
 * The reports module that once filled this tray was removed (owner, 26 Aug
 * 2026); what still lands here is the employee data export (REQ-M-05),
 * requested from an employee's page by whoever holds employee.manage. The
 * tray itself needs no permission: every row it shows is the caller's own
 * request.
 *
 * The counts along the top answer "is the thing I asked for ready" and are
 * the filter for "where is it". Rows are grouped by the day they were asked
 * for, the way any downloads tray is. Still a list of rows rather than a
 * grid of cards, still no card inside a card (CLAUDE.md §3 rule 3), and the
 * same header/toolbar/content structure as every other screen.
 */

type Bucket = 'ready' | 'preparing' | 'failed' | 'expired';

const BUCKET_ORDER: readonly Bucket[] = ['ready', 'preparing', 'failed', 'expired'];

const BUCKET_LABELS: Record<Bucket, string> = {
  ready: 'Ready',
  preparing: 'Preparing',
  failed: 'Failed',
  expired: 'Expired',
};

/**
 * The families come from the attendance status scale rather than a second
 * palette invented here, so a green chip means the same thing on this screen as
 * it does on My Attendance (CLAUDE.md §3 rule 4).
 */
const BUCKET_FAMILY: Record<Bucket, Family> = {
  ready: 'success',
  preparing: 'info',
  failed: 'destructive',
  expired: 'quiet',
};

/**
 * A finished job whose file has been purged is still DONE on the server. It is
 * not "ready" to anybody looking at this screen, though, so retention is what
 * separates the two rather than status alone.
 */
function bucketOf(job: ExportJobSummary): Bucket {
  if (job.status === 'FAILED') return 'failed';
  if (job.status === 'QUEUED' || job.status === 'RUNNING') return 'preparing';
  return job.downloadable ? 'ready' : 'expired';
}

function StatusBadge({ job }: { job: ExportJobSummary }) {
  const bucket = bucketOf(job);
  if (bucket === 'ready') {
    return (
      <Badge variant="secondary" className="gap-1">
        <CheckCircleIcon className="size-3" />
        {EXPORT_STATUS_LABELS.DONE}
      </Badge>
    );
  }
  if (bucket === 'failed') {
    return (
      <Badge variant="destructive" className="gap-1">
        <WarningCircleIcon className="size-3" />
        {EXPORT_STATUS_LABELS.FAILED}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1">
      <HourglassIcon className="size-3" />
      {bucket === 'expired' ? BUCKET_LABELS.expired : EXPORT_STATUS_LABELS[job.status]}
    </Badge>
  );
}

/**
 * The counts, and the filter, in one row.
 *
 * A ToggleGroup rather than buttons with hand-managed pressed state: it carries
 * the radio semantics and arrow-key movement, and Base UI hands back an array,
 * so pressing the active chip again clears the filter -- which is the right
 * behaviour for "show everything" and saves a separate All chip.
 */
function CountFilter({
  counts,
  active,
  onActiveChange,
}: {
  counts: Record<Bucket, number>;
  active: Bucket | null;
  onActiveChange: (next: Bucket | null) => void;
}) {
  const present = BUCKET_ORDER.filter((bucket) => counts[bucket] > 0);
  if (present.length === 0) return null;

  return (
    <ToggleGroup
      aria-label="Filter downloads by state"
      value={active === null ? [] : [active]}
      onValueChange={(value) => {
        onActiveChange((value[0] as Bucket | undefined) ?? null);
      }}
      className="flex flex-wrap items-center gap-x-1 gap-y-3 border p-1.5 sm:gap-y-1"
    >
      {present.map((bucket) => (
        <ToggleGroupItem
          key={bucket}
          value={bucket}
          className="gap-1.5 px-2 text-xs data-pressed:bg-muted"
        >
          <span aria-hidden className={cn('size-3 shrink-0 border', toneClasses(BUCKET_FAMILY[bucket], 'filled'))} />
          <span className={cn('font-medium tabular-nums', FAMILY_TEXT[BUCKET_FAMILY[bucket]])}>
            {counts[bucket]}
          </span>
          <span className="text-muted-foreground">{BUCKET_LABELS[bucket]}</span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function ExportRow({ job }: { job: ExportJobSummary }) {
  const download = useDownloadExport();
  const running = job.status === 'QUEUED' || job.status === 'RUNNING';
  const bucket = bucketOf(job);

  function start() {
    download.mutate(job.id, {
      onSuccess: (link) => {
        // A real navigation to a signed URL rather than an anchor rendered into
        // the row: the link is short-lived and must be fetched at the moment
        // the reader asks, not when the list rendered.
        window.location.assign(link.url);
      },
      onError: (error: Error) => {
        toast.add({ type: 'error', title: 'Could not download', description: error.message });
      },
    });
  }

  return (
    <div className="flex flex-col gap-2 border-b p-3 last:border-b-0 sm:grid sm:grid-cols-[minmax(12rem,24rem)_1fr_auto] sm:items-center sm:gap-4">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{job.reportLabel}</span>
          <StatusBadge job={job} />
        </div>
        <p className="text-muted-foreground truncate text-xs tabular-nums">{job.filename}</p>

        {running ? (
          <Progress value={job.progress} className="mt-2 max-w-xs">
            <ProgressLabel>{EXPORT_STATUS_LABELS[job.status]}</ProgressLabel>
            <ProgressValue />
          </Progress>
        ) : null}

        {job.status === 'FAILED' && job.error !== null ? (
          <p className="text-destructive mt-1 text-xs">{job.error}</p>
        ) : null}
      </div>

      {/* Four facts on one line, in fixed columns so they align down the list
          rather than each row placing them wherever its title happens to end.
          The labels are for a screen reader only: sighted readers get the
          alignment instead, and four repeated words on every row is exactly the
          kind of bulk this screen did not need. */}
      <dl className="text-muted-foreground grid shrink-0 grid-cols-2 gap-x-4 gap-y-0.5 text-xs sm:grid-cols-[3rem_4rem_8rem_7rem] sm:gap-x-5 sm:text-right">
        <dt className="sr-only">Format</dt>
        <dd className="tabular-nums">{job.format}</dd>
        <dt className="sr-only">Rows</dt>
        <dd className="tabular-nums">{job.rowCount === null ? EMPTY_VALUE : job.rowCount}</dd>
        <dt className="sr-only">Asked at</dt>
        <dd className="tabular-nums">{formatTimestamp(job.requestedAt)}</dd>
        <dt className="sr-only">Retention</dt>
        <dd className="tabular-nums">
          {bucket === 'expired'
            ? 'Deleted'
            : job.status === 'DONE'
              ? describeExpiry(job.expiresAt)
              : EMPTY_VALUE}
        </dd>
      </dl>

      <div className="shrink-0">
        <Button
          variant="outline"
          size="sm"
          className="w-full gap-2 sm:w-auto"
          disabled={!job.downloadable || download.isPending}
          onClick={start}
        >
          <DownloadSimpleIcon data-icon="inline-start" />
          Download
        </Button>
      </div>
    </div>
  );
}

/** "Today", "Yesterday", or the date -- the way a downloads tray reads. */
function dayLabel(iso: string): string {
  const parsed = parseISO(iso);
  if (Number.isNaN(parsed.getTime())) return 'Earlier';
  if (isToday(parsed)) return 'Today';
  if (isYesterday(parsed)) return 'Yesterday';
  return formatDate(iso.slice(0, 10));
}

export function DownloadsPage() {
  const jobs = useExportJobs();
  const [filter, setFilter] = useState<Bucket | null>(null);

  const data = useMemo(() => jobs.data ?? [], [jobs.data]);

  const counts = useMemo(() => {
    const tally: Record<Bucket, number> = { ready: 0, preparing: 0, failed: 0, expired: 0 };
    for (const job of data) tally[bucketOf(job)] += 1;
    return tally;
  }, [data]);

  // Grouped after filtering, so a day whose only job was filtered out does not
  // leave its heading behind over an empty stretch.
  const groups = useMemo(() => {
    const visible = filter === null ? data : data.filter((job) => bucketOf(job) === filter);
    const byDay = new Map<string, ExportJobSummary[]>();
    for (const job of visible) {
      const label = dayLabel(job.requestedAt);
      const bucket = byDay.get(label);
      if (bucket) bucket.push(job);
      else byDay.set(label, [job]);
    }
    return [...byDay.entries()];
  }, [data, filter]);

  return (
    <>
      <PageHeader description="Files you asked for. Each is kept for seven days, then deleted." />

      <div className="flex flex-col gap-4">
        {jobs.isSuccess && data.length > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CountFilter counts={counts} active={filter} onActiveChange={setFilter} />
            <Button
              variant="ghost"
              size="sm"
              disabled={jobs.isFetching}
              onClick={() => {
                void jobs.refetch();
              }}
            >
              <ArrowClockwiseIcon data-icon="inline-start" />
              Refresh
            </Button>
          </div>
        ) : null}

        {jobs.isPending ? (
          <div role="status" aria-busy="true" aria-label="Loading downloads" className="border">
            {Array.from({ length: 4 }, (_, index) => (
              <div
                key={index}
                aria-hidden
                className="flex items-center gap-4 border-b p-3 last:border-b-0"
              >
                <div className="flex-1">
                  <Skeleton className="h-3 w-40" />
                  <Skeleton className="mt-2 h-3 w-64" />
                </div>
                <Skeleton className="h-8 w-24 shrink-0" />
              </div>
            ))}
          </div>
        ) : null}

        {jobs.isError ? (
          <Alert variant="destructive">
            <WarningCircleIcon />
            <AlertTitle>The downloads could not be loaded</AlertTitle>
            <AlertDescription>
              {jobs.error.message}
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => {
                  void jobs.refetch();
                }}
              >
                <ACTION_ICONS.retry data-icon="inline-start" />
                Try again
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        {jobs.isSuccess && data.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <TrayIcon />
              </EmptyMedia>
              <EmptyTitle>No downloads yet</EmptyTitle>
              <EmptyDescription>
                Request an export -- an employee&rsquo;s data, from their page -- and the file
                appears here while it is being prepared. Exports run in the background, so you
                can leave this screen and come back to it.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}

        {/* Filtered to nothing is a different state from having nothing. */}
        {jobs.isSuccess && data.length > 0 && groups.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyTitle>Nothing {filter === null ? '' : BUCKET_LABELS[filter].toLowerCase()}</EmptyTitle>
              <EmptyDescription>
                No file in this tray is in that state right now.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setFilter(null);
                }}
              >
                <ACTION_ICONS.clearFilters data-icon="inline-start" />
                Show all
              </Button>
            </EmptyContent>
          </Empty>
        ) : null}

        {groups.map(([label, rows]) => (
          <section key={label} className="flex flex-col gap-2">
            <SectionHeading title={label} />
            <div className="border">
              {rows.map((job) => (
                <ExportRow key={job.id} job={job} />
              ))}
            </div>
          </section>
        ))}

      </div>
    </>
  );
}
