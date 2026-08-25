import { useState } from 'react';
import { BooksIcon, LockKeyIcon, PercentIcon } from '@phosphor-icons/react';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { PageHeader } from '@/components/shared/page-header';
import { RecordPicker, type PickerOption } from '@/components/shared/record-picker';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { SectionHeading } from '@/components/shared/section-heading';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { useParties } from '@/features/masters/use-parties';
import { EMPTY_VALUE } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';
import { PERMISSIONS } from '@vyuha/shared';

import { overridePayload, parseDaysInput, parseRateInput, splitSettings } from './overrides-model';
import {
  useInterestPartySettings,
  useRemovePartySetting,
  useUpsertPartySetting,
  type InterestPartySetting,
} from './use-interest';

/**
 * D-22: the per-party interest overrides, reached from Settings rather than
 * the sidebar — a configuration surface, not a report.
 *
 * Two lists share the screen because they are two halves of one decision.
 * The overrides are where somebody beat the projection; the missing list is
 * where nobody has decided at all, and those parties accrue interest from
 * day zero — never a silent 30 — until Tally or an override names a figure.
 */

function terms(row: InterestPartySetting): string {
  if (row.creditDaysOverride !== null) return `${String(row.creditDaysOverride)} days (override)`;
  if (row.tallyCreditDays !== null) return `${String(row.tallyCreditDays)} days (Tally)`;
  return 'From day zero';
}

function ListSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading interest overrides" className="border">
      {Array.from({ length: 4 }, (_, index) => (
        <div
          key={index}
          aria-hidden
          className="flex min-h-9 items-center gap-4 border-b px-3 py-2.5 last:border-b-0"
        >
          <Skeleton className="h-3 w-40 shrink-0" />
          <Skeleton className="hidden h-3 w-24 shrink-0 sm:block" />
          <Skeleton className="ml-auto h-4 w-20 shrink-0" />
        </div>
      ))}
    </div>
  );
}

export function InterestOverridesPage() {
  const canConfigure = usePermission(PERMISSIONS.INTEREST_CONFIGURE);

  if (!canConfigure) {
    return (
      <>
        <PageHeader description="Per-party interest rate and credit day overrides for the interest cost reports." />
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockKeyIcon />
            </EmptyMedia>
            <EmptyTitle>You cannot change interest settings</EmptyTitle>
            <EmptyDescription>
              This screen needs the interest_cost.configure permission. Whoever can read the
              interest figures still cannot quietly change the rate they are computed at, which is
              why the two keys are separate.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </>
    );
  }

  return <OverridesBody />;
}

function OverridesBody() {
  const [partyId, setPartyId] = useState<string | null>(null);
  const [rate, setRate] = useState('');
  const [days, setDays] = useState('');

  const query = useInterestPartySettings();
  const parties = useParties({ page: 1, pageSize: 200 });
  const upsert = useUpsertPartySetting();
  const remove = useRemovePartySetting();

  const settings = query.data ?? [];
  const { overridden, missing } = splitSettings(settings);

  const partyOptions: PickerOption[] = (parties.data?.data ?? []).map((p) => ({
    id: p.id,
    label: p.name,
    hint: p.parentGroup,
  }));
  const picked = partyOptions.find((option) => option.id === partyId) ?? null;
  const existing = settings.find((setting) => setting.partyId === partyId);

  const rateParsed = parseRateInput(rate);
  const daysParsed = parseDaysInput(days);
  const payload = overridePayload(rateParsed, daysParsed);
  const saving = upsert.isPending || remove.isPending;

  function load(setting: InterestPartySetting) {
    setPartyId(setting.partyId);
    setRate(setting.interestRateOverride ?? '');
    setDays(setting.creditDaysOverride === null ? '' : String(setting.creditDaysOverride));
    upsert.reset();
    remove.reset();
  }

  function save() {
    if (partyId === null || payload === null || saving) return;
    upsert.mutate(
      { partyId, ...payload },
      {
        onSuccess: (saved) => {
          toast.add({
            type: 'success',
            title: `Override saved for ${saved.partyName}`,
            description: 'The change is recorded in the audit log.',
          });
          setPartyId(null);
          setRate('');
          setDays('');
        },
      },
    );
  }

  function removeOverride(setting: InterestPartySetting) {
    if (saving) return;
    remove.mutate(setting.partyId, {
      onSuccess: (removed) => {
        toast.add({
          type: 'success',
          title: `Override removed for ${removed.partyName}`,
          description:
            removed.tallyCreditDays === null
              ? 'No Tally credit period either, so this party now accrues from day zero.'
              : `Back to Tally's ${String(removed.tallyCreditDays)} credit days and the organisation rate.`,
        });
        if (setting.partyId === partyId) {
          setPartyId(null);
          setRate('');
          setDays('');
        }
      },
    });
  }

  const overrideColumns: RecordColumn<InterestPartySetting>[] = [
    {
      key: 'party',
      header: 'Party',
      cell: (row) => <span className="font-medium">{row.partyName}</span>,
    },
    { key: 'group', header: 'Group', cell: (row) => row.parentGroup, secondary: true },
    {
      key: 'tallyDays',
      header: 'Tally credit days',
      cell: (row) => (row.tallyCreditDays === null ? EMPTY_VALUE : String(row.tallyCreditDays)),
      numeric: true,
    },
    {
      key: 'overrideDays',
      header: 'Override days',
      cell: (row) => (row.creditDaysOverride === null ? EMPTY_VALUE : String(row.creditDaysOverride)),
      numeric: true,
    },
    {
      key: 'overrideRate',
      header: 'Override rate %',
      cell: (row) => row.interestRateOverride ?? EMPTY_VALUE,
      numeric: true,
    },
    {
      key: 'terms',
      header: 'Applied terms',
      cell: (row) =>
        row.creditTermsMissing ? <Badge variant="destructive">From day zero</Badge> : terms(row),
    },
    {
      key: 'actions',
      header: '',
      cell: (row) => (
        <span className="flex justify-end gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Edit the override for ${row.partyName}`}
            onClick={() => {
              load(row);
            }}
          >
            <ACTION_ICONS.edit data-icon="inline-start" />
            Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Remove the override for ${row.partyName}`}
            disabled={saving}
            onClick={() => {
              removeOverride(row);
            }}
          >
            <ACTION_ICONS.remove data-icon="inline-start" />
            Remove
          </Button>
        </span>
      ),
    },
  ];

  const missingColumns: RecordColumn<InterestPartySetting>[] = [
    {
      key: 'party',
      header: 'Party',
      cell: (row) => <span className="font-medium">{row.partyName}</span>,
    },
    { key: 'group', header: 'Group', cell: (row) => row.parentGroup, secondary: true },
    {
      key: 'accrues',
      header: 'Accrues',
      cell: () => <Badge variant="destructive">From day zero</Badge>,
    },
    {
      key: 'actions',
      header: '',
      cell: (row) => (
        <span className="flex justify-end">
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Set credit terms for ${row.partyName}`}
            onClick={() => {
              load(row);
            }}
          >
            <ACTION_ICONS.edit data-icon="inline-start" />
            Set terms
          </Button>
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader description="A rate or credit days set here beats what the Tally sync carries, per party. The organisation rate and day basis live under Settings." />

      <div className="flex flex-col gap-8">
        <div className="flex flex-col gap-4 border p-4">
          <SectionHeading
            title="Set an override"
            note="Leave a field empty to clear that half back to Tally's figure or the organisation rate."
          />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <RecordPicker
              id="override-party"
              label="Party"
              showLabel
              placeholder="Choose a party"
              searchPlaceholder="Search parties"
              emptyMessage="No party matches."
              icon={<BooksIcon className="text-muted-foreground" />}
              options={partyOptions}
              loading={parties.isPending}
              value={picked}
              onValueChange={(next) => {
                setPartyId(next?.id ?? null);
                const known = settings.find((setting) => setting.partyId === next?.id);
                setRate(known?.interestRateOverride ?? '');
                setDays(
                  known === undefined || known.creditDaysOverride === null
                    ? ''
                    : String(known.creditDaysOverride),
                );
              }}
            />
            <Field data-invalid={rateParsed.kind === 'invalid' ? true : undefined}>
              <FieldLabel htmlFor="override-rate">Rate override (% per annum)</FieldLabel>
              <Input
                id="override-rate"
                inputMode="decimal"
                className="tabular-nums"
                placeholder="Organisation rate"
                aria-invalid={rateParsed.kind === 'invalid'}
                value={rate}
                onChange={(event) => {
                  setRate(event.target.value);
                }}
              />
            </Field>
            <Field data-invalid={daysParsed.kind === 'invalid' ? true : undefined}>
              <FieldLabel htmlFor="override-days">Credit days override</FieldLabel>
              <Input
                id="override-days"
                inputMode="numeric"
                className="tabular-nums"
                placeholder={
                  existing !== undefined && existing.tallyCreditDays !== null
                    ? `Tally: ${String(existing.tallyCreditDays)}`
                    : 'No Tally credit period'
                }
                aria-invalid={daysParsed.kind === 'invalid'}
                value={days}
                onChange={(event) => {
                  setDays(event.target.value);
                }}
              />
            </Field>
            <div className="flex items-end">
              <Button
                className="w-full sm:w-auto"
                disabled={partyId === null || payload === null || saving}
                onClick={save}
              >
                {upsert.isPending ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <ACTION_ICONS.save data-icon="inline-start" />
                )}
                {upsert.isPending ? 'Saving' : 'Save override'}
              </Button>
            </div>
          </div>
          <p className="text-muted-foreground text-xs">
            {rateParsed.kind === 'invalid'
              ? 'The rate must be a number between 0 and 100.'
              : daysParsed.kind === 'invalid'
                ? 'Credit days must be a whole number between 0 and 365.'
                : partyId !== null && payload === null
                  ? 'Both fields are empty; use Remove on the list below to clear an override entirely.'
                  : 'Saving is audited against your name.'}
          </p>
        </div>

        {upsert.isError || remove.isError ? (
          <QueryErrorAlert
            error={upsert.error ?? remove.error}
            subject="the override"
            onRetry={() => {
              // Retry re-runs the mutation that failed: the form still holds
              // a failed save's values, and the remove keeps its party id in
              // the mutation's own variables.
              if (upsert.isError) {
                save();
                return;
              }
              const failed = settings.find((setting) => setting.partyId === remove.variables);
              if (failed !== undefined) removeOverride(failed);
            }}
          />
        ) : null}

        {query.isPending ? <ListSkeleton /> : null}

        {query.isError ? (
          <QueryErrorAlert
            error={query.error}
            subject="interest overrides"
            onRetry={() => {
              void query.refetch();
            }}
          />
        ) : null}

        {query.isSuccess ? (
          <div className="flex flex-col gap-3">
            <SectionHeading
              title="Overrides"
              note="Each row beats the Tally projection for that party only; removing it falls back."
            />
            {overridden.length === 0 ? (
              <Empty className="border">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <PercentIcon />
                  </EmptyMedia>
                  <EmptyTitle>No overrides yet</EmptyTitle>
                  <EmptyDescription>
                    Every party is priced at the organisation rate against the credit days the
                    Tally sync carries. Pick a party above to set a different rate or period.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <RecordTable
                columns={overrideColumns}
                rows={overridden}
                rowKey={(row) => row.partyId}
                mobilePrimary={(row) => row.partyName}
                mobileStatus={(row) =>
                  row.creditTermsMissing ? <Badge variant="destructive">From day zero</Badge> : null
                }
                mobileSupporting={(row) =>
                  `${terms(row)}${row.interestRateOverride === null ? '' : ` · ${row.interestRateOverride}%`}`
                }
                onRowActivate={load}
              />
            )}
          </div>
        ) : null}

        {query.isSuccess ? (
          <div className="flex flex-col gap-3">
            <SectionHeading
              title="Credit terms missing"
              note="Neither Tally nor an override names credit days, so overdue interest accrues from the voucher date (D-22)."
            />
            {missing.length === 0 ? (
              <p className="text-muted-foreground border px-3 py-2.5 text-xs">
                Every debtor and creditor has credit terms, from Tally or from an override.
              </p>
            ) : (
              <RecordTable
                columns={missingColumns}
                rows={missing}
                rowKey={(row) => row.partyId}
                mobilePrimary={(row) => row.partyName}
                mobileStatus={() => <Badge variant="destructive">From day zero</Badge>}
                mobileSupporting={(row) => row.parentGroup}
                onRowActivate={load}
              />
            )}
          </div>
        ) : null}
      </div>
    </>
  );
}
