import { CheckSquareIcon, LockKeyIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { PERMISSIONS } from '@vyuha/shared';

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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/components/ui/toast';
import { PageHeader } from '@/components/shared/page-header';
import { ExportButton } from './export-button';
import { defaultRange } from './period';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { apiRequest } from '@/lib/api/client';
import { EMPTY_VALUE, formatCount, formatDate, formatMoney } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';

import { useCfoWorkLists, type WorkListRowData } from './use-cfo';

/**
 * The work lists (brief E1, E3, Phase 2): the credit ladder and the first
 * revenue-recovery lists, one layout, list configs -- never a screen per
 * list (0.9). Every row is a name, an amount and a reason, and ends in an
 * action that creates a task (A1): the push lands in the CRM kanban with
 * the context pre-filled.
 */

export function WorkListsPage() {
  const canView = usePermission(PERMISSIONS.CFO_SALES_VIEW);
  const canTask = usePermission(PERMISSIONS.CRM_TASK_MANAGE);
  const query = useCfoWorkLists({ enabled: canView });
  const [active, setActive] = useState<string | null>(null);
  const [pushing, setPushing] = useState<string | null>(null);

  if (!canView) {
    return (
      <>
        <PageHeader
          description="The standing work lists: who to call, for how much, and why."
          action={<ExportButton report="work-lists" range={defaultRange()} />}
        />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot view the work lists</EmptyTitle>
            <EmptyDescription>This needs the cfo.sales.view permission.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  const lists = query.data?.lists ?? [];
  const activeKey = active ?? lists.find((l) => l.rows.length > 0)?.key ?? lists[0]?.key ?? '';
  const activeList = lists.find((l) => l.key === activeKey);

  async function pushToTasks(listLabel: string, row: WorkListRowData) {
    setPushing(`${activeKey}:${row.party}`);
    try {
      await apiRequest('/tasks', {
        method: 'POST',
        body: {
          title: `${listLabel}: ${row.party}`,
          description: `${row.reason}. Amount: ${row.amount}.`,
          priority: 'HIGH',
        },
      });
      toast.add({ type: 'success', title: 'Task created', description: `${row.party} is on the board.` });
    } catch (error) {
      toast.add({
        type: 'error',
        title: 'Could not create the task',
        description: error instanceof Error ? error.message : 'Try again.',
      });
    } finally {
      setPushing(null);
    }
  }

  const columns: RecordColumn<WorkListRowData>[] = [
    { key: 'party', header: 'Party', cell: (row) => row.party },
    { key: 'amount', header: 'Amount', cell: (row) => formatMoney(row.amount), numeric: true },
    { key: 'reason', header: 'Why', cell: (row) => <span className="text-pretty">{row.reason}</span> },
    {
      key: 'oldest',
      header: 'Oldest bill',
      cell: (row) => (row.oldestBill ? formatDate(row.oldestBill) : EMPTY_VALUE),
      secondary: true,
    },
    ...(canTask
      ? [
          {
            key: 'action',
            header: '',
            cell: (row: WorkListRowData) => (
              <Button
                variant="outline"
                size="sm"
                disabled={pushing === `${activeKey}:${row.party}`}
                onClick={() => {
                  void pushToTasks(activeList?.label ?? '', row);
                }}
              >
                <CheckSquareIcon data-icon="inline-start" />
                Create task
              </Button>
            ),
          },
        ]
      : []),
  ];

  return (
    <>
      <PageHeader description="The standing work lists: who to call, for how much, and why. Every row can become a task on the board." />
      <div className="flex flex-col gap-4">
        {query.isPending ? <Skeleton className="h-64" /> : null}
        {query.isError ? (
          <QueryErrorAlert error={query.error} subject="work lists" onRetry={() => void query.refetch()} />
        ) : null}

        {query.data ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Tabs
                value={activeKey}
                onValueChange={(value) => {
                  setActive(String(value));
                }}
              >
                <TabsList className="h-auto flex-wrap">
                  {lists.map((list) => (
                    <TabsTrigger key={list.key} value={list.key} className="gap-1.5">
                      {list.label}
                      <Badge variant={list.rows.length > 0 ? 'secondary' : 'ghost'}>{formatCount(list.rows.length)}</Badge>
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
              <span className="text-muted-foreground text-xs tabular-nums">Book as of {formatDate(query.data.asOf)}</span>
            </div>

            {activeList ? (
              <p className="text-muted-foreground text-sm text-pretty">{activeList.hint}</p>
            ) : null}

            {activeList && activeList.rows.length > 0 ? (
              <RecordTable
                columns={columns}
                rows={[...activeList.rows]}
                rowKey={(row) => `${activeKey}:${row.partyId ?? row.party}`}
                mobilePrimary={(row) => row.party}
                mobileSupporting={(row) => `${formatMoney(row.amount)} · ${row.reason}`}
              />
            ) : (
              <Empty className="border">
                <EmptyHeader>
                  <EmptyTitle>Nothing on this list</EmptyTitle>
                  <EmptyDescription>
                    Good news, mostly: nobody qualifies for it today. Lists refill as the nightly photograph
                    and the voucher pull move.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </>
        ) : null}
      </div>
    </>
  );
}
