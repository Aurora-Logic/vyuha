import { useState, type ReactNode } from 'react';

import { RecordPicker, type PickerOption } from '@/components/shared/record-picker';
import { useDebouncedValue } from '@/lib/use-debounced-value';

import { useCompanies, useCompany } from './use-crm';
import type { Company } from './types';

/**
 * A CRM company, chosen from the whole book — not the first 200 of it.
 *
 * `useCompanyOptions` read `/crm/companies?pageSize=200` once and let the
 * combobox filter those rows in the browser, so on a book past 200 companies
 * the 201st could not be attached to a contact, a deal or a sales document,
 * and the field said "No company matches" for a company that exists. This
 * searches on the server as you type (the endpoint matches name, city and
 * website) and reaches any of them.
 *
 * Shaped exactly like `PartyPicker`, down to the resolve-by-id and the
 * prepended selection, because it is the same problem against a different
 * list and a second shape would be a second thing to keep right.
 */

function toCompanyOption(company: Company): PickerOption {
  return {
    id: company.id,
    label: company.name,
    ...(company.city === null ? {} : { hint: company.city }),
  };
}

interface CompanyPickerProps {
  /** The chosen company's id, or null. */
  companyId: string | null;
  /**
   * The chosen company's name, when the caller already holds it. Given it, the
   * trigger reads at once and no by-id read is issued.
   */
  companyName?: string;
  /** The whole row on a fresh pick, null on clear. */
  onValueChange: (company: Company | null) => void;
  label: string;
  /** Render the label above the control, as a field rather than a bare trigger. */
  showLabel?: boolean;
  placeholder: string;
  enabled?: boolean;
  clearable?: boolean;
  clearLabel?: string;
  disabled?: boolean;
  id?: string;
  icon?: ReactNode;
  className?: string;
}

export function CompanyPicker({
  companyId,
  companyName,
  onValueChange,
  label,
  showLabel = false,
  placeholder,
  enabled = true,
  clearable = false,
  clearLabel,
  disabled = false,
  id,
  icon,
  className,
}: CompanyPickerProps) {
  const [search, setSearch] = useState('');
  const debounced = useDebouncedValue(search, 200).trim();
  const list = useCompanies({ page: 1, ...(debounced ? { q: debounced } : {}) }, { enabled });
  const rows = list.data?.data ?? [];

  // The last row we handed back, kept so re-selecting or opening cold reads the
  // name at once rather than an ellipsis.
  const [picked, setPicked] = useState<Company | null>(null);
  const needsResolve =
    enabled && companyId !== null && companyName === undefined && (picked === null || picked.id !== companyId);
  const resolved = useCompany(needsResolve ? companyId : null);
  const selected = picked?.id === companyId ? picked : (resolved.data ?? null);

  const value: PickerOption | null =
    companyId === null
      ? null
      : selected
        ? toCompanyOption(selected)
        : companyName !== undefined
          ? { id: companyId, label: companyName }
          : { id: companyId, label: '…' };

  // The chosen company is prepended when the current search page does not hold
  // it, so its row still carries a tick and stays selectable.
  const options =
    value && !rows.some((row) => row.id === value.id)
      ? [value, ...rows.map(toCompanyOption)]
      : rows.map(toCompanyOption);

  return (
    <RecordPicker
      id={id}
      icon={icon}
      label={label}
      {...(className === undefined ? {} : { className })}
      showLabel={showLabel}
      placeholder={placeholder}
      searchPlaceholder="Name, city or website"
      emptyMessage="No company matches that."
      options={options}
      value={value}
      // isPending, not isFetching: keepPreviousData holds the last results on
      // screen while the next search loads, so typing does not flash a spinner.
      loading={list.isPending}
      clearable={clearable}
      clearLabel={clearLabel}
      disabled={disabled}
      search={search}
      onSearchChange={setSearch}
      onValueChange={(option) => {
        if (option === null) {
          setPicked(null);
          onValueChange(null);
          return;
        }
        const row = rows.find((candidate) => candidate.id === option.id);
        // The already chosen value echoed back from `options` has no row on
        // this page; clearing on it would drop a selection the user only meant
        // to re-confirm.
        if (row) {
          setPicked(row);
          onValueChange(row);
        }
      }}
    />
  );
}
