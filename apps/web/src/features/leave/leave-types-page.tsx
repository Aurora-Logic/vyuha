import { useState } from 'react';
import { CalendarBlankIcon, PlusIcon, ScalesIcon, WarningCircleIcon } from '@phosphor-icons/react';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { ListSkeleton } from '@/components/shared/list-skeleton';
import { PageHeader } from '@/components/shared/page-header';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { RowActions } from '@/components/shared/row-actions';
import { ShortcutHint } from '@/components/shared/shortcut-hint';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { DeleteMasterDialog, type DeleteTarget } from '@/features/org-masters';
import { ApiError } from '@/lib/api/client';
import { useShortcut } from '@/lib/keyboard/registry';
import { usePermission } from '@/lib/session/permissions';
import { PERMISSIONS } from '@vyuha/shared';

import { apiErrorCopy } from './api-error-copy';
import { BalanceAdjustmentSheet } from './balance-adjustment-sheet';
import { SampleDataNotice } from './sample-data-notice';
import { LeaveTypeSheet } from './leave-type-sheet';
import { ACCRUAL_METHOD_LABELS, type LeaveTypePolicy } from './types';
import { useLeaveTypes } from './use-leave';

/**
 * REQ-G-01, G-03 / PRD §5 screen 12: the leave policy table.
 *
 * Every number in this table is a count of days. There is no rate, no amount
 * and no currency anywhere on this screen, and none may be added (NFR-10):
 * this product produces the inputs to payroll and does not run it.
 */

/** Yes/no as a word, not a tick: a scan down the column has to be readable. */
function YesNo({ value }: { value: boolean }) {
  return value ? <Badge variant="secondary">Yes</Badge> : <span className="text-muted-foreground">No</span>;
}

/** Zero means "not allowed" for both caps, and reads better said than shown. */
/**
 * Null means the rule does not apply -- the type carries nothing forward, or
 * carries everything. Zero means it applies and the answer is none, which is a
 * different fact and reads differently.
 */
function DaysOrNone({ value, unlimited }: { value: number | null; unlimited?: boolean }) {
  if (unlimited === true) return <span className="text-muted-foreground">Unlimited</span>;
  if (value === null || value <= 0) return <span className="text-muted-foreground">None</span>;
  return <span className="tabular-nums">{value}</span>;
}

const BASE_COLUMNS: RecordColumn<LeaveTypePolicy>[] = [
  {
    key: 'name',
    header: 'Type',
    cell: (row) => <span className="font-medium">{row.name}</span>,
  },
  {
    key: 'code',
    header: 'Code',
    cell: (row) => <span className="tabular-nums">{row.code}</span>,
  },
  { key: 'paid', header: 'Paid', cell: (row) => <YesNo value={row.isPaid} /> },
  {
    key: 'accrual',
    header: 'Accrual',
    cell: (row) => ACCRUAL_METHOD_LABELS[row.accrualMethod],
    secondary: true,
  },
  {
    key: 'entitlement',
    header: 'Entitlement',
    cell: (row) => row.annualEntitlement,
    numeric: true,
  },
  {
    key: 'carry',
    header: 'Carry-forward cap',
    cell: (row) => (
      <DaysOrNone
        value={row.carryForwardAllowed ? row.carryForwardCap : null}
        unlimited={row.carryForwardAllowed && row.carryForwardCap === null}
      />
    ),
    numeric: true,
  },
  {
    key: 'negative',
    header: 'Negative limit',
    cell: (row) => <DaysOrNone value={row.negativeBalanceLimit} />,
    numeric: true,
  },
  {
    key: 'notice',
    header: 'Notice days',
    cell: (row) => row.noticeDays,
    numeric: true,
    secondary: true,
  },
  { key: 'halfDay', header: 'Half day', cell: (row) => <YesNo value={row.allowsHalfDay} /> },
  {
    key: 'encashable',
    header: 'Encashable',
    cell: (row) => <YesNo value={row.isEncashable} />,
    secondary: true,
  },
];

export function LeaveTypesPage() {
  const canManage = usePermission(PERMISSIONS.LEAVE_POLICY_MANAGE);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<LeaveTypePolicy | null>(null);
  const [deleting, setDeleting] = useState<DeleteTarget | null>(null);
  const [adjustOpen, setAdjustOpen] = useState(false);

  const query = useLeaveTypes();
  const rows = query.data?.data ?? [];
  const sample = query.data?.sample ?? false;

  function openNew() {
    setEditing(null);
    setSheetOpen(true);
  }

  function openEdit(row: LeaveTypePolicy) {
    setEditing(row);
    setSheetOpen(true);
  }

  /**
   * The two verbs each row offers.
   *
   * Rendered in a trailing column above 768px and in the stacked row's action
   * slot below it, so a phone is not left with a policy it can read and not
   * change (PRD §6.5). This replaced a whole-row click that opened the editor
   * with nothing on screen saying so — which is the gap this slice exists to
   * close.
   */
  function actionsFor(row: LeaveTypePolicy) {
    const blocked = canManage
      ? undefined
      : 'Needs the leave.policy.manage permission, which your account does not hold.';
    return (
      <RowActions
        label={`Actions for ${row.name}`}
        actions={[
          {
            key: 'edit',
            label: 'Edit leave type',
            icon: ACTION_ICONS.edit,
            onSelect: () => {
              openEdit(row);
            },
            ...(blocked === undefined ? {} : { unavailableReason: blocked }),
          },
          {
            key: 'delete',
            label: 'Delete leave type',
            icon: ACTION_ICONS.remove,
            destructive: true,
            onSelect: () => {
              setDeleting({
                entityType: 'leaveType',
                id: row.id,
                name: row.name,
                consequences: [
                  'Nobody can apply for it afterwards, and it disappears from the leave form.',
                  'Balances already earned against it are kept, and past requests still name it.',
                ],
              });
            },
            ...(blocked === undefined ? {} : { unavailableReason: blocked }),
          },
        ]}
      />
    );
  }

  const columns: RecordColumn<LeaveTypePolicy>[] = [
    ...BASE_COLUMNS,
    { key: 'actions', header: 'Actions', className: 'w-12 text-right', cell: actionsFor },
  ];

  // PRD §6.4: Alt+C creates a master on the fly. A leave type is a master.
  useShortcut({
    id: 'leave-types.create',
    keys: 'alt+c',
    label: 'New leave type',
    scope: 'screen',
    when: () => canManage,
    run: openNew,
  });

  return (
    <>
      {sample ? <SampleDataNotice endpoint="/api/v1/leave/types" /> : null}

      <PageHeader
        description="How each kind of leave accrues, carries forward and may be taken. Days only — no amounts are held in this product."
        action={
          canManage ? (
            <>
              {/* PRD §5 screen 12 is "Leave Types & Balances", and the balance
                  half had no surface at all. Outline rather than the primary
                  fill: creating a type is the ordinary act on this screen,
                  correcting somebody's balance is not. */}
              <Button
                variant="outline"
                onClick={() => {
                  setAdjustOpen(true);
                }}
              >
                <ScalesIcon data-icon="inline-start" />
                Correct a balance
              </Button>
              <Button onClick={openNew}>
                <PlusIcon data-icon="inline-start" />
                New leave type
                <ShortcutHint keys="alt+c" className="ml-1 hidden md:inline-flex" />
              </Button>
            </>
          ) : (
            <span className="text-muted-foreground text-xs">
              Editing needs the leave.policy.manage permission.
            </span>
          )
        }
      />

      {query.isPending ? <ListSkeleton rows={5} label="Loading leave types" /> : null}

      {query.isError ? (
        <Alert variant="destructive">
          <WarningCircleIcon />
          <AlertTitle>
            {apiErrorCopy(query.error, {
              subject: 'leave types',
              permission: 'leave.policy.manage',
            }).title}
          </AlertTitle>
          <AlertDescription>
            {
              apiErrorCopy(query.error, {
                subject: 'leave types',
                permission: 'leave.policy.manage',
              }).description
            }
            {query.error instanceof ApiError && query.error.requestId ? (
              <span className="mt-1 block font-mono text-[0.6875rem]">
                Request {query.error.requestId}
              </span>
            ) : null}
          </AlertDescription>
          <AlertAction>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void query.refetch();
              }}
            >
              Try again
            </Button>
          </AlertAction>
        </Alert>
      ) : null}

      {query.isSuccess && rows.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <CalendarBlankIcon />
            </EmptyMedia>
            <EmptyTitle>No leave types yet</EmptyTitle>
            <EmptyDescription>
              Nobody can apply for leave until at least one type exists. Casual, sick and earned
              leave are the usual starting set.
            </EmptyDescription>
          </EmptyHeader>
          {canManage ? (
            <EmptyContent>
              <Button variant="outline" size="sm" onClick={openNew}>
                <PlusIcon data-icon="inline-start" />
                New leave type
              </Button>
            </EmptyContent>
          ) : null}
        </Empty>
      ) : null}

      {rows.length > 0 ? (
        <RecordTable
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          mobilePrimary={(row) => row.name}
          // The whole row is deliberately not clickable any more. A gesture
          // with nothing on screen announcing it is the reason an
          // administrator could not find edit or delete at all; the menu says
          // both out loud, and nesting a button inside a clickable row would
          // announce one control as two to a screen reader.
          mobileStatus={(row) => (
            <div className="flex items-center gap-1">
              <Badge variant="outline">{row.code}</Badge>
              {actionsFor(row)}
            </div>
          )}
          mobileSupporting={(row) =>
            `${row.isPaid ? 'Paid' : 'Unpaid'} · ${String(row.annualEntitlement)} days a year · ${
              row.allowsHalfDay ? 'half days allowed' : 'full days only'
            }`
          }
        />
      ) : null}

      <LeaveTypeSheet open={sheetOpen} onOpenChange={setSheetOpen} editing={editing} />
      <BalanceAdjustmentSheet open={adjustOpen} onOpenChange={setAdjustOpen} />
      <DeleteMasterDialog
        target={deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      />
    </>
  );
}
