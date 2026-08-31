import { useSearchParams } from 'react-router';

import { DateRangeField } from '@/features/attendance/pickers';

import { INSIGHT_PRESETS, rangeAsPickerValue, toApiDate } from './period';

/**
 * The period picker every insights screen carries, and the one thing it does:
 * write `from` and `to` into the URL, replacing rather than pushing so Back
 * leaves the report instead of walking back through each period tried.
 *
 * Sixteen screens spelled this out individually, three of them through their
 * own `setParams` wrapper, all sixteen meaning exactly the same thing.
 */
export function PeriodRangeField({
  range,
  label = 'Period',
}: {
  readonly range: { readonly from: string; readonly to: string };
  readonly label?: string;
}) {
  const [, setSearchParams] = useSearchParams();
  return (
    <DateRangeField
      label={label}
      value={rangeAsPickerValue(range)}
      presets={INSIGHT_PRESETS}
      onValueChange={(next) => {
        if (!next.from || !next.to) return;
        const from = toApiDate(next.from);
        const to = toApiDate(next.to);
        setSearchParams(
          (current) => {
            const params = new URLSearchParams(current);
            params.set('from', from);
            params.set('to', to);
            return params;
          },
          { replace: true },
        );
      }}
    />
  );
}
