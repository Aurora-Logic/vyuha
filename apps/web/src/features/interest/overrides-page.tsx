import { useState } from 'react';
import { BooksIcon, LockKeyIcon, PackageIcon, PercentIcon } from '@phosphor-icons/react';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { ListSkeleton } from '@/components/shared/list-skeleton';
import { PageHeader } from '@/components/shared/page-header';
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from '@/components/ui/toast';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { PartyPicker } from '@/features/masters/party-picker';
import { EMPTY_VALUE } from '@/lib/format';
import { usePermission } from '@/lib/session/permissions';
import { CATEGORIES, PERMISSIONS } from '@vyuha/shared';

import { overridePayload, parseDaysInput, parseRateInput, splitSettings } from './overrides-model';
import {
  useInterestPartySettings,
  useRemovePartySetting,
  useRemoveStockSetting,
  useStockInterestSettings,
  useUpsertPartySetting,
  useUpsertStockSetting,
  type InterestPartySetting,
  type StockInterestSetting,
} from './use-interest';

/**
 * D-22: the per-party and stock interest overrides, reached from Settings rather than
 * the sidebar — a configuration surface, not a report.
 */

function terms(row: InterestPartySetting): string {
  if (row.creditDaysOverride !== null) return `${String(row.creditDaysOverride)} days (override)`;
  if (row.tallyCreditDays !== null) return `${String(row.tallyCreditDays)} days (Tally)`;
  return 'From day zero';
}

export function InterestOverridesPage() {
  const canConfigure = usePermission(PERMISSIONS.INTEREST_CONFIGURE);

  if (!canConfigure) {
    return (
      <>
        <PageHeader description="Per-party and stock interest rate and holding day overrides for interest cost reports." />
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

  return (
    <>
      <PageHeader description="A rate or credit/holding period set here beats organization defaults and Tally sync data." />
      <Tabs defaultValue="parties" className="flex flex-col gap-6">
        <TabsList>
          <TabsTrigger value="parties">Parties (Customers & Vendors)</TabsTrigger>
          <TabsTrigger value="stock">Stock (Groups, Categories & Items)</TabsTrigger>
        </TabsList>
        <TabsContent value="parties">
          <PartyOverridesBody />
        </TabsContent>
        <TabsContent value="stock">
          <StockOverridesBody />
        </TabsContent>
      </Tabs>
    </>
  );
}

function PartyOverridesBody() {
  const [partyId, setPartyId] = useState<string | null>(null);
  const [rate, setRate] = useState('');
  const [days, setDays] = useState('');

  const query = useInterestPartySettings();
  const upsert = useUpsertPartySetting();
  const remove = useRemovePartySetting();

  const settings = query.data ?? [];
  const { overridden, missing } = splitSettings(settings);

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
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4 border p-4">
        <SectionHeading
          title="Set a party override"
          note="Leave a field empty to clear that half back to Tally's figure or the organisation rate."
        />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <PartyPicker
            id="override-party"
            label="Party"
            showLabel
            placeholder="Choose a party"
            icon={<BooksIcon className="text-muted-foreground" />}
            partyId={partyId}
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
            if (upsert.isError) {
              save();
              return;
            }
            const failed = settings.find((setting) => setting.partyId === remove.variables);
            if (failed !== undefined) removeOverride(failed);
          }}
        />
      ) : null}

      {query.isPending ? <ListSkeleton rows={4} label="Loading interest overrides" /> : null}

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
  );
}

function StockOverridesBody() {
  const [targetType, setTargetType] = useState<'group' | 'category' | 'item'>('category');
  const [targetName, setTargetName] = useState('');
  const [rate, setRate] = useState('');
  const [days, setDays] = useState('');

  const query = useStockInterestSettings();
  const upsert = useUpsertStockSetting();
  const remove = useRemoveStockSetting();

  const settings = query.data ?? [];

  const rateParsed = parseRateInput(rate);
  const daysParsed = parseDaysInput(days);
  const hasValue = rateParsed.kind === 'set' || daysParsed.kind === 'set';
  const isValid = targetName.trim().length > 0 && hasValue && rateParsed.kind !== 'invalid' && daysParsed.kind !== 'invalid';
  const saving = upsert.isPending || remove.isPending;

  function load(setting: StockInterestSetting) {
    setTargetType(setting.targetType);
    setTargetName(setting.targetName);
    setRate(setting.interestRateOverride ?? '');
    setDays(setting.holdingPeriodDaysOverride === null ? '' : String(setting.holdingPeriodDaysOverride));
    upsert.reset();
    remove.reset();
  }

  function save() {
    if (!isValid || saving) return;
    upsert.mutate(
      {
        targetType,
        targetName: targetName.trim(),
        interestRateOverride: rateParsed.kind === 'set' ? rateParsed.value : null,
        holdingPeriodDaysOverride: daysParsed.kind === 'set' ? daysParsed.value : null,
      },
      {
        onSuccess: (saved) => {
          toast.add({
            type: 'success',
            title: `Stock override saved for ${saved.targetName}`,
            description: 'The change takes effect on stock interest calculations.',
          });
          setTargetName('');
          setRate('');
          setDays('');
        },
      },
    );
  }

  function removeOverride(setting: StockInterestSetting) {
    if (saving) return;
    remove.mutate(setting.id, {
      onSuccess: (removed) => {
        toast.add({
          type: 'success',
          title: `Override removed for ${removed.targetName}`,
          description: 'Reverted back to the organization default rate and holding period.',
        });
      },
    });
  }

  const stockColumns: RecordColumn<StockInterestSetting>[] = [
    {
      key: 'type',
      header: 'Target Type',
      cell: (row) => (
        <Badge variant="outline" className="capitalize">
          {row.targetType}
        </Badge>
      ),
    },
    {
      key: 'target',
      header: 'Name',
      cell: (row) => <span className="font-medium">{row.targetName}</span>,
    },
    {
      key: 'rate',
      header: 'Rate Override %',
      cell: (row) => (row.interestRateOverride === null ? EMPTY_VALUE : `${row.interestRateOverride}%`),
      numeric: true,
    },
    {
      key: 'days',
      header: 'Free Holding Days Override',
      cell: (row) =>
        row.holdingPeriodDaysOverride === null ? EMPTY_VALUE : `${String(row.holdingPeriodDaysOverride)} days`,
      numeric: true,
    },
    {
      key: 'actions',
      header: '',
      cell: (row) => (
        <span className="flex justify-end gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Edit ${row.targetName}`}
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
            aria-label={`Remove ${row.targetName}`}
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

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4 border p-4">
        <SectionHeading
          title="Set a stock interest override"
          note="Configure custom annual rate % or free holding period days for specific Product Groups, Categories, or Stock Items."
        />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field>
            <FieldLabel htmlFor="stock-target-type">Target scope</FieldLabel>
            <Select
              value={targetType}
              onValueChange={(val: string | null) => {
                if (val) {
                  setTargetType(val as 'group' | 'category' | 'item');
                  setTargetName('');
                }
              }}
            >
              <SelectTrigger id="stock-target-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="category">Category (MCB, MCCB, etc.)</SelectItem>
                  <SelectItem value="group">Product Group (Brand/Parent)</SelectItem>
                  <SelectItem value="item">Specific Stock Item</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>

          {targetType === 'category' ? (
            <Field>
              <FieldLabel htmlFor="stock-target-category">Category name</FieldLabel>
              <Select
                value={targetName}
                onValueChange={(val: string | null) => {
                  if (val) setTargetName(val);
                }}
              >
                <SelectTrigger id="stock-target-category" className="w-full">
                  <SelectValue placeholder="Select category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {CATEGORIES.map((cat) => (
                      <SelectItem key={cat} value={cat}>
                        {cat}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          ) : (
            <Field>
              <FieldLabel htmlFor="stock-target-name">
                {targetType === 'group' ? 'Product Group name' : 'Stock Item name'}
              </FieldLabel>
              <Input
                id="stock-target-name"
                placeholder={targetType === 'group' ? 'e.g. Schneider Electric' : 'e.g. MCB 6A SP'}
                value={targetName}
                onChange={(e) => {
                  setTargetName(e.target.value);
                }}
              />
            </Field>
          )}

          <Field data-invalid={rateParsed.kind === 'invalid' ? true : undefined}>
            <FieldLabel htmlFor="stock-override-rate">Annual rate % override</FieldLabel>
            <Input
              id="stock-override-rate"
              inputMode="decimal"
              className="tabular-nums"
              placeholder="Org rate (default 12%)"
              aria-invalid={rateParsed.kind === 'invalid'}
              value={rate}
              onChange={(event) => {
                setRate(event.target.value);
              }}
            />
          </Field>

          <Field data-invalid={daysParsed.kind === 'invalid' ? true : undefined}>
            <FieldLabel htmlFor="stock-override-days">Free holding days override</FieldLabel>
            <Input
              id="stock-override-days"
              inputMode="numeric"
              className="tabular-nums"
              placeholder="Org default (90 days)"
              aria-invalid={daysParsed.kind === 'invalid'}
              value={days}
              onChange={(event) => {
                setDays(event.target.value);
              }}
            />
          </Field>
        </div>

        <div className="flex justify-end">
          <Button disabled={!isValid || saving} onClick={save}>
            {upsert.isPending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <ACTION_ICONS.save data-icon="inline-start" />
            )}
            {upsert.isPending ? 'Saving' : 'Save stock override'}
          </Button>
        </div>
      </div>

      {query.isPending ? <ListSkeleton rows={3} label="Loading stock overrides" /> : null}

      {query.isError ? (
        <QueryErrorAlert
          error={query.error}
          subject="stock interest overrides"
          onRetry={() => {
            void query.refetch();
          }}
        />
      ) : null}

      {query.isSuccess ? (
        <div className="flex flex-col gap-3">
          <SectionHeading
            title="Active stock overrides"
            note="Group, category, or item overrides beat the organisation stock policy (rate % and 90-day grace period)."
          />
          {settings.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <PackageIcon />
                </EmptyMedia>
                <EmptyTitle>No stock overrides yet</EmptyTitle>
                <EmptyDescription>
                  All stock items adhere to the organisation stock annual rate and 90-day holding period.
                  Use the form above to configure category or group specific policies.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <RecordTable
              columns={stockColumns}
              rows={settings}
              rowKey={(row) => row.id}
              mobilePrimary={(row) => row.targetName}
              mobileStatus={(row) => (
                <Badge variant="outline" className="capitalize">
                  {row.targetType}
                </Badge>
              )}
              mobileSupporting={(row) =>
                `${row.interestRateOverride ? `${row.interestRateOverride}% p.a.` : 'Org rate'} · ${
                  row.holdingPeriodDaysOverride ? `${String(row.holdingPeriodDaysOverride)} free days` : 'Org holding days'
                }`
              }
              onRowActivate={load}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}
