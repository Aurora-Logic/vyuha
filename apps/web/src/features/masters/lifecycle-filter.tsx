import { useState } from 'react';
import { subMonths } from 'date-fns';
import { useSearchParams } from 'react-router';

import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { fromDateParam, toDateParam } from '@/features/attendance/format';
import { DateRangeField, type RangePreset } from '@/features/attendance/pickers';
import { fyStart, periodForGranularity, type CompareMode } from '@/lib/period-compare';

import { COMPARE_LABELS, writeLifecyclePeriod, type LifecyclePeriod } from './lifecycle-period';

/**
 * The period and the comparison, above the figures. The calendar is the
 * shared Calendar/Popover/Sheet composition (a bottom sheet on a phone),
 * with the presets a trader reaches for: this month, this FY quarter,
 * this FY to date, the last twelve months, last FY. State lives in the
 * URL, so the back button and a shared link keep it.
 */

function today(): string {
  return toDateParam(new Date());
}

function lastFinancialYear(): { from: Date; to: Date } {
  const start = fromDateParam(fyStart(today()));
  return { from: subMonths(start, 12), to: new Date(start.getFullYear(), start.getMonth(), 0) };
}

const PRESETS: readonly RangePreset[] = [
  { label: 'Today', range: () => ({ from: new Date(), to: new Date() }) },
  { label: 'This month', range: () => toDates(periodForGranularity('month', today())) },
  { label: 'This quarter', range: () => toDates(periodForGranularity('quarter', today())) },
  { label: 'This financial year', range: () => toDates(periodForGranularity('year', today())) },
  { label: 'Last 12 months', range: () => ({ from: subMonths(new Date(), 12), to: new Date() }) },
  { label: 'Last financial year', range: lastFinancialYear },
];

function toDates(range: { from: string; to: string }): { from: Date; to: Date } {
  return { from: fromDateParam(range.from), to: fromDateParam(range.to) };
}

export function LifecycleFilter({ period }: { period: LifecyclePeriod }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
      <DateRangeField
        label="Period"
        value={toDates(period.range)}
        onValueChange={(next) => {
          if (next.from === undefined || next.to === undefined) return;
          setSearchParams(writeLifecyclePeriod(searchParams, { range: { from: toDateParam(next.from), to: toDateParam(next.to) } }), { replace: true });
        }}
        open={open}
        onOpenChange={setOpen}
        presets={PRESETS}
        className="w-full sm:w-auto"
      />
      <Select
        value={period.compare}
        onValueChange={(value) => {
          if (value === null) return;
          setSearchParams(writeLifecyclePeriod(searchParams, { compare: value }), { replace: true });
        }}
      >
        <SelectTrigger aria-label="Compare with" className="w-full sm:w-56">
          <SelectValue>{(current: CompareMode) => COMPARE_LABELS[current]}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {(Object.keys(COMPARE_LABELS) as CompareMode[]).map((mode) => (
              <SelectItem key={mode} value={mode}>
                {COMPARE_LABELS[mode]}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  );
}
