import { useState } from 'react';
import { LockKeyIcon } from '@phosphor-icons/react';
import { PERMISSIONS } from '@vyuha/shared';
import type { DateRange } from 'react-day-picker';
import { useParams, useSearchParams } from 'react-router';

import { PageHeader } from '@/components/shared/page-header';
import { Badge } from '@/components/ui/badge';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { DateRangeField } from '@/features/attendance/pickers';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { PaperPage, PaperPageSkeleton } from '@/features/documents/paper-page';
import { statementAsPaper } from '@/features/documents/paper-record';
import { fromApiDate, toApiDate } from '@/features/insights/period';
import { fyStart } from '@/lib/period-compare';
import { DASHBOARD_PRESETS } from '@/lib/range-presets';
import { usePermission } from '@/lib/session/permissions';

import { usePartyStatement } from './use-parties';

const TITLE = 'Statement of Account';

/**
 * Report 48 (doc 18): a party's statement of account for a period, on the
 * organisation's paper, printed to PDF or downloaded as Excel from the
 * same shell every other document wears. The period lives in the URL so
 * the print route reads the same one and the link can be sent on.
 */
export function PartyStatementPage() {
  const { id = '' } = useParams<{ id: string }>();
  const canView = usePermission(PERMISSIONS.RECEIVABLES_VIEW);
  const [searchParams, setSearchParams] = useSearchParams();
  const today = toApiDate(new Date());
  const from = searchParams.get('from') ?? fyStart(today);
  const to = searchParams.get('to') ?? today;
  // A range takes two clicks. The URL, and with it the query, move only once
  // both are in; the half-picked range lives here so the calendar shows it.
  const [draft, setDraft] = useState<DateRange | null>(null);
  const statement = usePartyStatement(canView && id !== '' ? id : null, from, to);

  if (!canView) {
    return (
      <>
        <PageHeader title={TITLE} description="A party's account over a period, for sending or filing." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot view statements</EmptyTitle>
            <EmptyDescription>This needs the receivables.view permission.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  const picker = (
    <DateRangeField
      label="Statement period"
      value={draft ?? { from: fromApiDate(from), to: fromApiDate(to) }}
      presets={DASHBOARD_PRESETS}
      className="max-md:w-full"
      onValueChange={(next) => {
        if (next.from === undefined || next.to === undefined) {
          setDraft(next);
          return;
        }
        setDraft(null);
        const params = new URLSearchParams(searchParams);
        params.set('from', toApiDate(next.from));
        params.set('to', toApiDate(next.to));
        setSearchParams(params, { replace: true });
      }}
    />
  );

  if (statement.isError) {
    return (
      <>
        <PageHeader title={TITLE} action={picker} />
        <QueryErrorAlert error={statement.error} subject="the statement" onRetry={() => { void statement.refetch(); }} />
      </>
    );
  }
  if (statement.data === undefined) return <PaperPageSkeleton label="Loading the statement" />;

  const party = statement.data.party;
  const period = new URLSearchParams({ from, to }).toString();
  return (
    <PaperPage
      docType="STATEMENT"
      record={statementAsPaper(statement.data)}
      backTo={`/masters/parties/${id}`}
      backLabel={party.name}
      title={TITLE}
      badges={<Badge variant="outline">{party.parentGroup}</Badge>}
      actions={picker}
      printPath={`/print/statements/${id}?${period}`}
      excel={{ path: `/masters/parties/${id}/statement.xlsx?${period}`, filename: `Statement-${party.name.replace(/[^\w.-]+/gu, '_')}-${from}-to-${to}.xlsx` }}
    />
  );
}
