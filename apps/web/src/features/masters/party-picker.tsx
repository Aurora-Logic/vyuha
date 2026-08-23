import { useState, type ReactNode } from 'react';

import { duplicateWarning } from '@/components/shared/duplicate-flag';
import { RecordPicker, type PickerOption } from '@/components/shared/record-picker';
import { useDebouncedValue } from '@/lib/use-debounced-value';

import { useParties, useParty, type Party } from './use-parties';

/**
 * A customer or vendor, chosen from the whole book — not the first page of it.
 *
 * The old wiring loaded 25 parties and let the combobox filter those in the
 * browser, so a 1,000-party book hid party 26 onward from every document. This
 * searches on the server as you type, and reaches any party by name, alias or
 * GSTIN. It carries only the id in and hands the whole row back out, so a caller
 * holds an id and this resolves the name for the trigger — by remembering the
 * pick, and for a document opened cold, by id (cached, so the flash is one
 * frame at most).
 */

function toPartyOption(party: Party): PickerOption {
  return {
    id: party.id,
    label: party.name,
    ...(party.gstin === null ? {} : { hint: party.gstin }),
    ...(party.duplicate ? { warning: duplicateWarning(party.duplicate) } : {}),
  };
}

interface PartyPickerProps {
  /** The chosen party's id, or null. */
  partyId: string | null;
  /**
   * The chosen party's name, when the caller already holds it (a saved row that
   * carries the vendor's name). Given it, the trigger reads at once and no by-id
   * read is issued. Omit it and the name is resolved from the id.
   */
  partyName?: string;
  /** The whole row on a fresh pick, null on clear. */
  onValueChange: (party: Party | null) => void;
  label: string;
  placeholder: string;
  /** Only customers, or only vendors, when the caller wants one side of the book. */
  parentGroup?: string;
  enabled?: boolean;
  clearable?: boolean;
  clearLabel?: string;
  disabled?: boolean;
  id?: string;
  icon?: ReactNode;
}

export function PartyPicker({
  partyId,
  partyName,
  onValueChange,
  label,
  placeholder,
  parentGroup,
  enabled = true,
  clearable = false,
  clearLabel,
  disabled = false,
  id,
  icon,
}: PartyPickerProps) {
  const [search, setSearch] = useState('');
  const debounced = useDebouncedValue(search, 200).trim();
  const list = useParties(
    {
      page: 1,
      pageSize: 25,
      ...(debounced ? { q: debounced } : {}),
      ...(parentGroup ? { parentGroup } : {}),
    },
    { enabled },
  );
  const rows = list.data?.data ?? [];

  // The last row we handed back, kept so re-selecting or opening cold reads the
  // name at once rather than an ellipsis.
  const [picked, setPicked] = useState<Party | null>(null);
  // Only resolve when this picker is live and the caller did not hand us the
  // name: a disabled picker (the viewer lacks masters view) must not fire a
  // by-id read the server would 403, and a caller with the name in hand needs
  // no read at all.
  const needsResolve =
    enabled && partyId !== null && partyName === undefined && (picked === null || picked.id !== partyId);
  const resolved = useParty(needsResolve ? partyId : null);
  const selectedParty = picked?.id === partyId ? picked : (resolved.data ?? null);

  const value: PickerOption | null =
    partyId === null
      ? null
      : selectedParty
        ? toPartyOption(selectedParty)
        : partyName !== undefined
          ? { id: partyId, label: partyName }
          : { id: partyId, label: '…' };

  // The chosen party is prepended when the current search page does not contain
  // it, so its row still carries a tick and stays selectable.
  const options =
    value && !rows.some((row) => row.id === value.id)
      ? [value, ...rows.map(toPartyOption)]
      : rows.map(toPartyOption);

  return (
    <RecordPicker
      id={id}
      icon={icon}
      label={label}
      placeholder={placeholder}
      searchPlaceholder="Name, alias or GSTIN"
      emptyMessage="No party matches that."
      options={options}
      value={value}
      // isPending, not isFetching: with keepPreviousData the last results stay
      // on screen while the next search loads, so typing does not flash the
      // list to a spinner on every settled keystroke.
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
        // A row only comes from this page's results on a real pick. The already
        // chosen value echoed back from `options` has no row here, and clearing
        // on it would drop a selection the user only meant to re-confirm.
        if (row) {
          setPicked(row);
          onValueChange(row);
        }
      }}
    />
  );
}
