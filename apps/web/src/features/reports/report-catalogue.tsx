import { Fragment, useEffect, useState, type KeyboardEvent } from 'react';
import { ChartBarIcon } from '@phosphor-icons/react';
import { useNavigate, useSearchParams } from 'react-router';

import { REPORT_CATEGORY_ICONS } from '@/components/shared/entity-icons';
import { PageHeader } from '@/components/shared/page-header';
import { SearchField } from '@/components/shared/search-field';
import { SectionHeading } from '@/components/shared/section-heading';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemSeparator,
  ItemTitle,
} from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { REPORT_CATEGORIES, type ReportCategory, type ReportDefinition } from '@vyuha/shared';

import { useRecentReports } from './api';
import { CategoryChip } from './category-chip';

/**
 * The Reports hub (REQ-AD-03), rebuilt after the owner's 25 Aug verdict that
 * the module felt unorganised: sixty reports in one sortable table asked the
 * reader to already know what they were looking for.
 *
 * The hub now answers the three ways people actually arrive. Typing — the
 * search field is first and already focused on a desk. Habit — the reports
 * this person opened last, as one row of chips, served by the API so it is
 * the same truth the usage table holds. Browsing — every category as its own
 * headed shelf, in the catalogue's own reading order, each report one calm
 * row of name and what it answers.
 *
 * One list, no view toggle: the toggle offered two arrangements of the same
 * sixty rows, which was one more decision before any data. The catalogue
 * still shows only what the server sent — a report the caller cannot open is
 * not greyed out, it is absent.
 */

const CATEGORY_BLURBS: Record<ReportCategory, string> = {
  Attendance: 'Registers, musters and the exceptions of the working day.',
  Approvals: 'Who decided what, how fast, and what is still waiting.',
  Leave: 'Balances, ledgers and what was availed.',
  Books: 'Mirrors of the Tally projection — Vyuha computes nothing here.',
  Receivables: 'Who owes what, against what limit.',
  Customers: 'Buying behaviour: who buys, what, how often, at what rate.',
  Inventory: 'What is on the shelf, how fast it moves, where money sits.',
  Vendors: 'Who supplies what, at what rate, compared.',
  Fulfilment: 'Orders on their way through the warehouse.',
  Exceptions: 'Reports whose ideal state is empty.',
};

/**
 * One report as one row, in the same Item composition RecordTable's mobile
 * cards use, so the hub's rows and every table's phone rows are one pattern.
 * role="button" with Enter and Space because the whole row is the target — a
 * row whose title alone is clickable teaches people to aim.
 *
 * The chip appears only in search results. Inside a section the heading
 * already names the category, and a chip on every row would say the same
 * word sixty times.
 */
function ReportRow({
  report,
  withChip,
  onOpen,
}: {
  report: ReportDefinition;
  withChip: boolean;
  onOpen: () => void;
}) {
  return (
    <Item
      size="sm"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        // The row advertises role="button", and a control that claims that
        // role has to honour both keys.
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
      className="hover:bg-muted/50 active:bg-muted min-h-11 cursor-pointer rounded-none"
    >
      <ItemContent className="min-w-0 gap-0.5">
        <ItemTitle className="flex w-full min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate">{report.label}</span>
          {withChip ? <CategoryChip category={report.category} className="shrink-0" /> : null}
        </ItemTitle>
        <ItemDescription className="w-full min-w-0 truncate text-xs">
          {report.description}
        </ItemDescription>
      </ItemContent>
    </Item>
  );
}

/**
 * The rows share their ItemGroup wrapper wherever a list of them renders.
 * role="presentation" overrides ItemGroup's built-in role="list": rows that
 * are all role="button" leave no listitem, so a screen reader would announce
 * an empty list. gap-0 because ItemGroup spaces its children by default,
 * which would float the separators in space instead of dividing flush rows.
 */
function ReportRowGroup({
  reports,
  withChip,
  onOpen,
}: {
  reports: readonly ReportDefinition[];
  withChip: boolean;
  onOpen: (report: ReportDefinition) => void;
}) {
  return (
    <ItemGroup role="presentation" className="gap-0 border">
      {reports.map((report, index) => (
        <Fragment key={report.key}>
          {index > 0 ? <ItemSeparator className="my-0" /> : null}
          <ReportRow
            report={report}
            withChip={withChip}
            onOpen={() => {
              onOpen(report);
            }}
          />
        </Fragment>
      ))}
    </ItemGroup>
  );
}

function HubSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading the catalogue" className="flex flex-col gap-6">
      {Array.from({ length: 3 }, (_, section) => (
        <div key={section} aria-hidden className="flex flex-col gap-2">
          <Skeleton className="h-4 w-32" />
          <div className="border">
            {Array.from({ length: 4 }, (_, row) => (
              <div key={row} className="flex min-h-11 flex-col justify-center gap-1.5 border-b px-3 py-2 last:border-b-0">
                <Skeleton className="h-3 w-40" />
                <Skeleton className="h-3 w-72 max-w-full" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function NoMatches({ narrowed }: { narrowed: boolean }) {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ChartBarIcon />
        </EmptyMedia>
        <EmptyTitle>No report matches</EmptyTitle>
        <EmptyDescription>
          {narrowed
            ? 'Try another word, or show all categories. A report you cannot open is not listed.'
            : 'Try another word. A report you cannot open is not listed.'}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function ReportCatalogue({
  reports,
  loading,
  error = null,
}: {
  reports: readonly ReportDefinition[];
  loading: boolean;
  /**
   * A failed catalogue read. Without it an errored load renders as "no report
   * matches", which reads as a permissions problem. `cause` carries the raw
   * failure so the shared alert can map its code and print the request id.
   */
  error?: { message: string; cause?: unknown; retry: () => void } | null;
}) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const categoryParam = searchParams.get('category');
  const category = REPORT_CATEGORIES.find((c) => c === categoryParam) ?? null;
  const [q, setQ] = useState('');
  const recent = useRecentReports();

  useEffect(() => {
    // md+ only: an autofocused field on a phone throws the keyboard over the
    // list before the reader has seen what is on it.
    if (window.matchMedia('(min-width: 768px)').matches) {
      document.getElementById('report-search')?.focus();
    }
  }, []);

  const needle = q.trim().toLowerCase();
  const searching = needle !== '';

  // The category link narrows the shelf; the search narrows within whatever
  // is shown. Label and description only — the description is how somebody
  // finds the report they cannot name.
  const scoped = category === null ? reports : reports.filter((report) => report.category === category);
  const results = searching
    ? scoped.filter((report) => `${report.label} ${report.description}`.toLowerCase().includes(needle))
    : scoped;

  /*
   * Intersected with the catalogue rather than trusted: the server already
   * narrows to this caller's keys, but a client one release behind may not
   * know a key at all, and a chip that navigates to "not available" is worse
   * than no chip. No history, no row — a labelled empty shell would tell a
   * first-time visitor the feature is broken. Errors vanish the same way:
   * losing a shortcut must not take the catalogue down with it.
   */
  const recentReports = (recent.data ?? [])
    .map((key) => reports.find((report) => report.key === key))
    .filter((report): report is ReportDefinition => report !== undefined);

  function open(report: ReportDefinition) {
    const params = new URLSearchParams();
    params.set('report', report.key);
    // The period the reader came back with is carried into the next report,
    // so browsing between reports does not reset the dates each time. The
    // report screen narrows it to what that report can answer for.
    for (const key of ['from', 'to'] as const) {
      const value = searchParams.get(key);
      if (value !== null) params.set(key, value);
    }
    void navigate(`/reports?${params.toString()}`);
  }

  function showAll() {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete('category');
        return next;
      },
      { replace: true },
    );
  }

  const sections = REPORT_CATEGORIES.filter((c) => results.some((report) => report.category === c));

  return (
    <>
      <PageHeader description="Every report, searchable and grouped. Each one shares the same shell: filters, columns, saved views, export and scheduling." />
      <div className="flex flex-col gap-4">
        <SearchField
          id="report-search"
          label="Search reports"
          value={q}
          onValueChange={setQ}
          placeholder="Name, or what it answers"
          className="md:max-w-md"
        />

        {!loading && !searching && category === null && recentReports.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground text-xs">Recently used</span>
            {recentReports.map((report) => {
              const Glyph = REPORT_CATEGORY_ICONS[report.category];
              return (
                <Button
                  key={report.key}
                  variant="outline"
                  size="sm"
                  className="font-normal"
                  onClick={() => {
                    open(report);
                  }}
                >
                  <Glyph className="text-muted-foreground" />
                  {report.label}
                </Button>
              );
            })}
          </div>
        ) : null}

        {category !== null ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="text-muted-foreground text-xs">Showing {category} only.</p>
            <Button variant="ghost" size="sm" onClick={showAll}>
              Show all reports
            </Button>
          </div>
        ) : null}

        {loading ? <HubSkeleton /> : null}

        {!loading && error !== null ? (
          <QueryErrorAlert error={error.cause} subject="the report list" onRetry={error.retry} />
        ) : null}

        {!loading && error === null && results.length === 0 ? <NoMatches narrowed={category !== null} /> : null}

        {/* Search flattens the shelves: a match in Vendors beside a match in
            Leave, each wearing its chip because no heading says it. */}
        {!loading && searching && results.length > 0 ? (
          <ReportRowGroup reports={results} withChip onOpen={open} />
        ) : null}

        {!loading && !searching && results.length > 0 ? (
          <div className="flex flex-col gap-6">
            {sections.map((c) => {
              const Glyph = REPORT_CATEGORY_ICONS[c];
              return (
                <section key={c} className="flex flex-col gap-3">
                  <SectionHeading icon={<Glyph />} title={c} note={CATEGORY_BLURBS[c]} />
                  <ReportRowGroup
                    reports={results.filter((report) => report.category === c)}
                    withChip={false}
                    onOpen={open}
                  />
                </section>
              );
            })}
          </div>
        ) : null}
      </div>
    </>
  );
}
