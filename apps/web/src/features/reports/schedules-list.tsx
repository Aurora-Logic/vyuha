import { CalendarBlankIcon, PauseIcon, PlayIcon, TrashIcon } from '@phosphor-icons/react';
import {
  EXPORT_FORMAT_LABELS,
  REPORT_DEFINITIONS,
  describeSchedule,
  type ReportSchedule,
} from '@vyuha/shared';

import { SectionHeading } from '@/components/shared/section-heading';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { formatDate } from '@/lib/format';

import { useDeleteSchedule, useReportSchedules, useSetScheduleActive } from './api';

/**
 * REQ-J-05, listed where its output lands.
 *
 * On the Downloads screen rather than in Settings, because a schedule and the
 * files it produces are the same subject: somebody wondering why yesterday's
 * register has not arrived should find the timer next to the tray it delivers
 * to, not two screens apart.
 *
 * A schedule is not editable. Pausing, resuming and deleting are the whole of
 * it -- the report, its filters and its columns come from the shell that
 * created it, and re-editing them here would be a second, worse copy of the
 * filter bar that could drift from what the report actually accepts.
 */

function ScheduleRow({ schedule }: { schedule: ReportSchedule }) {
  const setActive = useSetScheduleActive();
  const remove = useDeleteSchedule();
  const label = REPORT_DEFINITIONS[schedule.reportKey]?.label ?? schedule.reportKey;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-3 py-3 last:border-b-0">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{schedule.name}</span>
          {schedule.isActive ? null : <Badge variant="outline">Paused</Badge>}
        </div>
        <span className="text-muted-foreground truncate text-xs">
          {label} · {describeSchedule(schedule)} · {EXPORT_FORMAT_LABELS[schedule.format]}
        </span>
        <span className="text-muted-foreground truncate text-xs">
          {schedule.lastRunOn === null
            ? 'Has not run yet'
            : `Last ran ${formatDate(schedule.lastRunOn)}`}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={setActive.isPending}
          onClick={() => {
            setActive.mutate(
              { id: schedule.id, isActive: !schedule.isActive },
              {
                onError: (error: Error) => {
                  toast.add({ type: 'error', title: 'Could not change it', description: error.message });
                },
              },
            );
          }}
        >
          {schedule.isActive ? (
            <>
              <PauseIcon data-icon="inline-start" />
              Pause
            </>
          ) : (
            <>
              <PlayIcon data-icon="inline-start" />
              Resume
            </>
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Delete ${schedule.name}`}
          className="text-destructive hover:text-destructive"
          disabled={remove.isPending}
          onClick={() => {
            remove.mutate(schedule.id, {
              onSuccess: () => {
                // Says what was *not* deleted. A schedule and its files look
                // like one thing on this screen, and somebody removing a timer
                // should not fear they have just deleted last month's reports.
                toast.add({
                  type: 'success',
                  title: 'Schedule deleted',
                  description: 'Files it already produced are still in Downloads.',
                });
              },
              onError: (error: Error) => {
                toast.add({ type: 'error', title: 'Could not delete it', description: error.message });
              },
            });
          }}
        >
          <TrashIcon />
        </Button>
      </div>
    </div>
  );
}

export function SchedulesList({ canExport }: { canExport: boolean }) {
  const schedules = useReportSchedules(canExport);

  if (!canExport) return null;

  return (
    <section className="flex flex-col gap-3">
      <SectionHeading
        title="Scheduled reports"
        note="Reports that run on their own. The file waits here when it is ready."
      />

      {schedules.isPending ? (
        <div className="flex flex-col gap-2" role="status" aria-busy="true">
          {Array.from({ length: 2 }, (_, index) => (
            <Skeleton key={index} className="h-14 w-full" />
          ))}
        </div>
      ) : schedules.isError ? (
        // A failed load must not wear the empty state: "Nothing scheduled"
        // over schedules that exist but could not be fetched tells the user
        // their timers are gone.
        <QueryErrorAlert
          error={schedules.error}
          subject="the scheduled reports"
          onRetry={() => {
            void schedules.refetch();
          }}
        />
      ) : schedules.data === undefined || schedules.data.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CalendarBlankIcon />
            </EmptyMedia>
            <EmptyTitle>Nothing scheduled</EmptyTitle>
            <EmptyDescription>
              Open a report, set the filters you want, and choose Schedule to have it run on its
              own.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="border">
          {schedules.data.map((schedule) => (
            <ScheduleRow key={schedule.id} schedule={schedule} />
          ))}
        </div>
      )}
    </section>
  );
}
