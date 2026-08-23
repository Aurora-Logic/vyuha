import { type ReactNode, useState } from 'react';

import { RecordPicker, type PickerOption } from '@/components/shared/record-picker';
import { useDebouncedValue } from '@/lib/use-debounced-value';

import { useStockItems, type StockItem } from './use-stock-items';

/**
 * A stock item, chosen from the whole catalogue — not the first page of it.
 *
 * A sales or purchase line loaded 25 items and filtered them in the browser, so
 * on a 5,000-item catalogue only the alphabetical first 25 could ever be picked
 * from a line. This searches on the server as you type and reaches any item.
 *
 * The caller already holds the chosen item's id and name (a saved line carries
 * both), so it passes them in as `value` and this needs no second read to label
 * the trigger; the whole row comes back on a fresh pick, for the line to prefill
 * unit and tax from.
 */

function toItemOption(item: StockItem): PickerOption {
  return {
    id: item.id,
    label: item.name,
    ...(item.alias === null ? {} : { hint: item.alias }),
  };
}

interface ItemPickerProps {
  /** The chosen item's id and name, or null. A saved line has both to hand. */
  value: PickerOption | null;
  /** The whole row on a fresh pick, null on clear. */
  onValueChange: (item: StockItem | null) => void;
  label: string;
  placeholder: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  enabled?: boolean;
  clearable?: boolean;
  clearLabel?: string;
  disabled?: boolean;
  id?: string;
  icon?: ReactNode;
}

export function ItemPicker({
  value,
  onValueChange,
  label,
  placeholder,
  searchPlaceholder = 'Search stock items',
  emptyMessage,
  enabled = true,
  clearable = false,
  clearLabel,
  disabled = false,
  id,
  icon,
}: ItemPickerProps) {
  const [search, setSearch] = useState('');
  const debounced = useDebouncedValue(search, 200).trim();
  const list = useStockItems(
    { page: 1, pageSize: 25, ...(debounced ? { q: debounced } : {}) },
    { enabled },
  );
  const rows = list.data?.data ?? [];

  const options =
    value && !rows.some((row) => row.id === value.id)
      ? [value, ...rows.map(toItemOption)]
      : rows.map(toItemOption);

  return (
    <RecordPicker
      id={id}
      icon={icon}
      label={label}
      placeholder={placeholder}
      searchPlaceholder={searchPlaceholder}
      emptyMessage={emptyMessage}
      options={options}
      value={value}
      // isPending, not isFetching: keepPreviousData holds the last results on
      // screen while the next search loads, so a keystroke does not flash the
      // list to a spinner.
      loading={list.isPending}
      clearable={clearable}
      clearLabel={clearLabel}
      disabled={disabled}
      search={search}
      onSearchChange={setSearch}
      onValueChange={(option) => {
        if (option === null) {
          onValueChange(null);
          return;
        }
        const row = rows.find((candidate) => candidate.id === option.id);
        if (row) onValueChange(row);
      }}
    />
  );
}
