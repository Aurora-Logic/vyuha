import type { DateRange } from 'react-day-picker';

import { BooksIcon } from '@phosphor-icons/react';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { flagClasses, flagLabel } from '@/features/attendance/status';
import { PartyPicker } from '@/features/masters/party-picker';
import { SearchField } from '@/components/shared/search-field';
import { ShortcutHint } from '@/components/shared/shortcut-hint';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { humaniseEnum } from '@/lib/format';
import {
  ATTENDANCE_FLAGS,
  ATTENDANCE_STATUSES,
  PUNCH_TYPES,
  SALES_ANALYSIS_DIMENSIONS,
  SALES_ANALYSIS_DIMENSION_LABELS,
  type ReportFilterName,
  type SalesAnalysisDimension,
} from '@vyuha/shared';

// The date pickers are shadcn Calendar/Popover/Sheet compositions living in the
// attendance feature; their own file says they belong in components/shared and
// are there only because that directory was locked while several screens were
// being built in parallel. Reusing them beats a second copy of the same
// composition, which is exactly what CLAUDE.md §3 asks for.
import { DateField, DateRangeField, MonthField, type RangePreset } from '@/features/attendance/pickers';
import { subDays } from 'date-fns';

import { fromDateParam } from '@/features/attendance/format';
import { periodForGranularity } from '@/lib/period-compare';

import { monthRange, type PeriodMode } from './period';

/**
 * REQ-J-01's filter bar: date range, location, department, employee, status,
 * flags -- and the punch direction, which the audit report needs and the
 * register has no use for.
 *
 * Which controls appear is driven by the report's own `filters` list, served
 * by the API. A report that cannot filter by status does not render a status
 * control that quietly does nothing.
 *
 * The period control follows the same rule. The daily muster is for one date
 * and the muster grid for one month, and each gets the instrument that says so
 * -- a range picker over a report that answers for a single day invites a
 * selection the server has to quietly narrow.
 */

const ALL = 'ALL';

export interface ReportFilterState {
  readonly period: DateRange;
  readonly departmentId: string | null;
  readonly locationId: string | null;
  readonly employeeId: string | null;
  readonly status: string | null;
  readonly flags: string | null;
  readonly punchType: string | null;
  /** Phase 6d: the receivables reports are about a party. */
  readonly partyId: string | null;
  /** Phase 6d: REQ-Y-05's dimension. */
  readonly groupBy: string | null;
  /** 14 REQ-AE-01: the day book's voucher-type narrowing. */
  readonly voucherType: string | null;
  /** 14 REQ-AE-02: the ledger the extract is for. */
  readonly ledgerName: string | null;
  /** 14: the item analyses narrow by item name. */
  readonly itemName: string | null;
}

interface Option {
  readonly id: string;
  readonly name: string;
}

interface FilterBarProps {
  available: readonly ReportFilterName[];
  periodMode: PeriodMode;
  value: ReportFilterState;
  onChange: (patch: Partial<ReportFilterState>) => void;
  departments: readonly Option[];
  locations: readonly Option[];
  /** Whether the viewer may read the Tally masters, so the party filter searches the book. */
  canReadParties?: boolean;
  periodOpen: boolean;
  onPeriodOpenChange: (open: boolean) => void;
  onClear: () => void;
  isFiltered: boolean;
  /**
   * The desktop toolbar draws the period on its own row -- what the data
   * covers, apart from how it reads -- so it renders `PeriodField` itself and
   * asks this bar for only the narrowing filters. The phone sheet keeps
   * everything together and leaves this unset.
   */
  hidePeriod?: boolean;
}

function OptionSelect({
  label,
  value,
  placeholder,
  options,
  onValueChange,
}: {
  label: string;
  value: string | null;
  placeholder: string;
  options: readonly Option[];
  onValueChange: (next: string | null) => void;
}) {
  return (
    <Select
      value={value ?? ALL}
      onValueChange={(next: string | null) => {
        onValueChange(next === null || next === ALL ? null : next);
      }}
    >
      <SelectTrigger aria-label={label} className="w-full sm:w-44">
        <SelectValue>
          {(current: string) =>
            options.find((option) => option.id === current)?.name ?? placeholder
          }
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value={ALL}>{placeholder}</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.name}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

export function ReportFilterBar({
  available,
  periodMode,
  value,
  onChange,
  departments,
  locations,
  canReadParties = true,
  periodOpen,
  onPeriodOpenChange,
  onClear,
  isFiltered,
  hidePeriod = false,
}: FilterBarProps) {
  const shows = (name: ReportFilterName) => available.includes(name);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {shows('partyId') ? (
        <div className="w-full sm:w-64">
          <PartyPicker
            label="Filter by party"
            placeholder="Choose a party"
            icon={<BooksIcon className="text-muted-foreground" />}
            enabled={canReadParties}
            clearable
            clearLabel="Any party"
            partyId={value.partyId}
            onValueChange={(next) => {
              onChange({ partyId: next?.id ?? null });
            }}
          />
        </div>
      ) : null}

      {shows('voucherType') ? (
        <div className="w-full sm:w-44">
          <SearchField
            id="report-voucher-type"
            label="Filter by voucher type"
            placeholder="Voucher type"
            value={value.voucherType ?? ''}
            onValueChange={(next) => {
              onChange({ voucherType: next.trim() === '' ? null : next });
            }}
          />
        </div>
      ) : null}

      {shows('ledgerName') ? (
        <div className="w-full sm:w-56">
          <SearchField
            id="report-ledger-name"
            label="Ledger name"
            placeholder="Ledger, as Tally names it"
            value={value.ledgerName ?? ''}
            onValueChange={(next) => {
              onChange({ ledgerName: next.trim() === '' ? null : next });
            }}
          />
        </div>
      ) : null}

      {shows('itemName') ? (
        <div className="w-full sm:w-48">
          <SearchField
            id="report-item-name"
            label="Filter by item"
            placeholder="Item name"
            value={value.itemName ?? ''}
            onValueChange={(next) => {
              onChange({ itemName: next.trim() === '' ? null : next });
            }}
          />
        </div>
      ) : null}

      {shows('groupBy') ? (
        <Select
          value={value.groupBy ?? 'party'}
          onValueChange={(next: string | null) => {
            onChange({ groupBy: next === null || next === 'party' ? null : next });
          }}
        >
          <SelectTrigger aria-label="Group by" className="w-full sm:w-40">
            <SelectValue>{(current: SalesAnalysisDimension) => SALES_ANALYSIS_DIMENSION_LABELS[current]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {SALES_ANALYSIS_DIMENSIONS.map((dimension) => (
                <SelectItem key={dimension} value={dimension}>
                  {SALES_ANALYSIS_DIMENSION_LABELS[dimension]}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      ) : null}

      {!hidePeriod && shows('period') ? <PeriodField
        mode={periodMode}
        value={value.period}
        onChange={onChange}
        open={periodOpen}
        onOpenChange={onPeriodOpenChange}
      /> : null}

      {shows('departmentId') ? (
        <OptionSelect
          label="Filter by department"
          placeholder={departments.length === 0 ? 'No departments' : 'All departments'}
          options={departments}
          value={value.departmentId}
          onValueChange={(next) => {
            onChange({ departmentId: next });
          }}
        />
      ) : null}

      {shows('locationId') ? (
        <OptionSelect
          label="Filter by location"
          placeholder={locations.length === 0 ? 'No locations' : 'All locations'}
          options={locations}
          value={value.locationId}
          onValueChange={(next) => {
            onChange({ locationId: next });
          }}
        />
      ) : null}

      {shows('status') ? (
        <Select
          value={value.status ?? ALL}
          onValueChange={(next: string | null) => {
            onChange({ status: next === null || next === ALL ? null : next });
          }}
        >
          <SelectTrigger aria-label="Filter by status" className="w-full sm:w-40">
            <SelectValue>
              {(current: string) => (current === ALL ? 'All statuses' : humaniseEnum(current))}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={ALL}>All statuses</SelectItem>
              {ATTENDANCE_STATUSES.map((status) => (
                <SelectItem key={status} value={status}>
                  {humaniseEnum(status)}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      ) : null}

      {shows('flags') ? (
        <Select
          value={value.flags ?? ALL}
          onValueChange={(next: string | null) => {
            onChange({ flags: next === null || next === ALL ? null : next });
          }}
        >
          <SelectTrigger aria-label="Filter by flag" className="w-full sm:w-40">
            <SelectValue>
              {(current: string) => (
                <span className="inline-flex items-center gap-1.5 [&_svg]:size-3.5">
                  <ACTION_ICONS.flag aria-hidden />
                  {current === ALL ? 'All flags' : humaniseEnum(current)}
                </span>
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={ALL}>All flags</SelectItem>
              {ATTENDANCE_FLAGS.map((flag) => (
                <SelectItem key={flag} value={flag}>
                  <ACTION_ICONS.flag aria-hidden className={flagClasses(flag).text} />
                  {flagLabel(flag)}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      ) : null}

      {shows('punchType') ? (
        <Select
          value={value.punchType ?? ALL}
          onValueChange={(next: string | null) => {
            onChange({ punchType: next === null || next === ALL ? null : next });
          }}
        >
          <SelectTrigger
            aria-label="Filter by direction"
            className="w-full sm:w-36"
          >
            <SelectValue>
              {(current: string) => (current === ALL ? 'In and out' : humaniseEnum(current))}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={ALL}>In and out</SelectItem>
              {PUNCH_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {humaniseEnum(type)}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      ) : null}

      {isFiltered ? (
        <Button variant="ghost" size="sm" onClick={onClear}>
          <ACTION_ICONS.clearFilters data-icon="inline-start" />
          Clear filters
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The period, in whichever instrument the report's own shape calls for.
 *
 * All three are existing shadcn Calendar/Popover/Sheet compositions from the
 * attendance feature (CLAUDE.md rule 1) -- on a phone each opens as a bottom
 * Sheet, and none of them is a native date input.
 */
export function PeriodField({
  mode,
  value,
  onChange,
  open,
  onOpenChange,
}: {
  mode: PeriodMode;
  value: DateRange;
  onChange: (patch: Partial<ReportFilterState>) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const hint = <ShortcutHint keys="alt+f2" className="ml-1 hidden md:inline-flex" />;
  const anchor = value.to ?? value.from ?? new Date();

  if (mode === 'date') {
    return (
      <DateField
        label="Muster date"
        value={anchor}
        onValueChange={(next) => {
          onChange({ period: { from: next, to: next } });
        }}
        open={open}
        onOpenChange={onOpenChange}
        className="w-full sm:w-auto"
        hint={hint}
      />
    );
  }

  if (mode === 'month') {
    return (
      <MonthField
        label="Report month"
        value={value.from ?? anchor}
        onValueChange={(next) => {
          onChange({ period: monthRange(next) });
        }}
        open={open}
        onOpenChange={onOpenChange}
        className="w-full sm:w-auto"
        hint={hint}
      />
    );
  }

  return (
    <DateRangeField
      label="Report period"
      value={value}
      onValueChange={(next) => {
        onChange({ period: next });
      }}
      open={open}
      onOpenChange={onOpenChange}
      className="w-full sm:w-auto"
      hint={hint}
      presets={PERIOD_PRESETS}
    />
  );
}

/** REQ-AD-19's presets in its order; the financial year runs April to March (REQ-AD-20). */
const PERIOD_PRESETS: readonly RangePreset[] = [
  { label: 'Today', range: () => ({ from: new Date(), to: new Date() }) },
  { label: 'Yesterday', range: () => ({ from: subDays(new Date(), 1), to: subDays(new Date(), 1) }) },
  { label: 'Last 7 days', range: () => ({ from: subDays(new Date(), 6), to: new Date() }) },
  { label: 'This month', range: () => fromStrings(periodForGranularity('month', todayString())) },
  { label: 'Last month', range: () => lastCalendarMonth() },
  { label: 'Last 30 days', range: () => ({ from: subDays(new Date(), 29), to: new Date() }) },
  { label: 'This quarter', range: () => fromStrings(periodForGranularity('quarter', todayString())) },
  { label: 'Last quarter', range: () => previousOf('quarter') },
  { label: 'This FY', range: () => fromStrings(periodForGranularity('year', todayString())) },
  { label: 'Last FY', range: () => previousOf('year') },
];

function todayString(): string {
  return new Date().toLocaleDateString('en-CA');
}

function fromStrings(range: { from: string; to: string }): DateRange {
  return { from: fromDateParam(range.from) ?? new Date(), to: fromDateParam(range.to) ?? new Date() };
}

/** The whole previous FY period (quarter or year), full months rather than to-date. */
function previousOf(granularity: 'quarter' | 'year'): DateRange {
  const current = periodForGranularity(granularity, todayString());
  const startDate = fromDateParam(current.from) ?? new Date();
  const endOfPrevious = subDays(startDate, 1);
  const previous = periodForGranularity(granularity, endOfPrevious.toLocaleDateString('en-CA'));
  return { from: fromDateParam(previous.from) ?? endOfPrevious, to: endOfPrevious };
}

function lastCalendarMonth(): DateRange {
  const now = new Date();
  return { from: new Date(now.getFullYear(), now.getMonth() - 1, 1), to: new Date(now.getFullYear(), now.getMonth(), 0) };
}
