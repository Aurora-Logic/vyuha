import { useState, type ReactNode } from 'react';
import { XIcon } from '@phosphor-icons/react';

import { SettingsRow } from '@/components/shared/settings-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FieldDescription } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { DurationField } from '@/features/attendance/pickers';

/**
 * The row shapes every settings section is made of.
 *
 * Composed once here rather than per section so the sections cannot drift into
 * several spellings of the same row (CLAUDE.md §3 rule 4), and so the
 * enforcement note below is impossible to forget: it is part of the row, not
 * something each call site remembers to add. Each is a `SettingsRow` -- label
 * and helper on the left, the control on the right, stacked on a phone -- so
 * a policy row and a profile row are the same row.
 */

/**
 * States, next to the control, whether anything currently reads it.
 *
 * REQ-L-02 lists policy fields that belong to features shipping in a later
 * phase. A switch that visibly moves while nothing reads it is worse than no
 * switch -- it reads as a control that has been turned on. The server decides
 * what goes here; the screen only prints it.
 */
export function EnforcementNote({ by }: { by: string | null | undefined }) {
  if (by === undefined) return null;
  if (by === null) {
    return (
      <FieldDescription>
        Saved and audited, but nothing reads it yet. Changing it does not change behaviour today.
      </FieldDescription>
    );
  }
  return <FieldDescription>In force now. Read by: {by}.</FieldDescription>;
}

interface NumberFieldProps {
  id: string;
  label: string;
  help: string;
  value: number;
  min: number;
  max: number;
  /** Rendered after the label, e.g. "minutes". */
  unit?: string;
  enforcedBy?: string | null;
  disabled?: boolean;
  onValueChange: (value: number) => void;
  /** Rendered under the enforcement note, for a per-field caveat. */
  children?: ReactNode;
}

/**
 * A bounded whole number.
 *
 * `type="number"` on shadcn's Input rather than a slider: these are exact
 * policy values typed from a written policy document, and every one of them is
 * bounded but not small. The same choice, for the same reason, as the shift
 * policy fields.
 */
export function PolicyNumberField({
  id,
  label,
  help,
  value,
  min,
  max,
  unit,
  enforcedBy,
  disabled,
  onValueChange,
  children,
}: NumberFieldProps) {
  return (
    <SettingsRow
      label={unit ? `${label} (${unit})` : label}
      htmlFor={id}
      description={help}
      note={
        <>
          <EnforcementNote by={enforcedBy} />
          {children}
        </>
      }
      disabled={disabled}
    >
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        disabled={disabled}
        className="tabular-nums"
        value={String(value)}
        onChange={(event) => {
          const next = Number(event.target.value);
          // An emptied field reads as 0, which several of these accept. NaN
          // does not, and is dropped rather than written into the draft.
          if (!Number.isNaN(next)) onValueChange(next);
        }}
      />
    </SettingsRow>
  );
}

interface ChoiceFieldProps<T extends string> {
  id: string;
  label: string;
  help?: string;
  value: T;
  options: readonly { value: T; label: string }[];
  enforcedBy?: string | null;
  disabled?: boolean;
  onValueChange: (value: T) => void;
  /** Rendered under the enforcement note, for a per-field caveat. */
  children?: ReactNode;
}

export function PolicyChoiceField<T extends string>({
  id,
  label,
  help,
  value,
  options,
  enforcedBy,
  disabled,
  onValueChange,
  children,
}: ChoiceFieldProps<T>) {
  return (
    <SettingsRow
      label={label}
      htmlFor={id}
      description={help}
      note={
        <>
          <EnforcementNote by={enforcedBy} />
          {children}
        </>
      }
      disabled={disabled}
    >
      <Select
        value={value}
        disabled={disabled}
        onValueChange={(next: string | null) => {
          // Base UI hands back null when a select is cleared. This one cannot
          // be, but the handler still has to accept it.
          if (next !== null) onValueChange(next as T);
        }}
      >
        <SelectTrigger id={id} aria-label={label} className="w-full">
          <SelectValue>
            {(current: string) =>
              options.find((option) => option.value === current)?.label ?? current
            }
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </SettingsRow>
  );
}

/** An on/off policy: a Switch at the far right of the row, with the same enforcement note as its neighbours. */
export function PolicyToggleField({
  id,
  label,
  help,
  value,
  enforcedBy,
  disabled,
  onValueChange,
}: {
  id: string;
  label: string;
  help?: string;
  value: boolean;
  enforcedBy: string | null | undefined;
  disabled?: boolean;
  onValueChange: (value: boolean) => void;
}) {
  return (
    <SettingsRow
      layout="end"
      label={label}
      htmlFor={id}
      description={help}
      note={<EnforcementNote by={enforcedBy} />}
      disabled={disabled}
    >
      <Switch id={id} checked={value} disabled={disabled} onCheckedChange={onValueChange} />
    </SettingsRow>
  );
}

/** A policy duration, picked in hours and minutes rather than typed (owner, 21 Aug 2026). */
export function PolicyDurationField({
  id,
  label,
  help,
  value,
  enforcedBy,
  disabled,
  onValueChange,
}: {
  id: string;
  label: string;
  help?: string;
  value: number;
  enforcedBy: string | null | undefined;
  disabled?: boolean;
  onValueChange: (minutes: number) => void;
}) {
  return (
    <SettingsRow
      label={label}
      htmlFor={id}
      description={help}
      note={<EnforcementNote by={enforcedBy} />}
      disabled={disabled}
    >
      <DurationField id={id} label={label} value={value} disabled={disabled} onValueChange={onValueChange} />
    </SettingsRow>
  );
}

/**
 * 15 REQ-AK-02: the return desk's reasons, as a list an organisation edits.
 *
 * Editable rather than fixed because "wrong item" and "quality rejection"
 * mean different things to a cable wholesaler and a machine shop, and the
 * reason report is only readable while the list stays short. Stored as the
 * words themselves, so retiring one never rewrites what an old receipt says.
 */
export function ReturnReasonsField({
  reasons,
  enforcedBy,
  onValueChange,
}: {
  reasons: readonly string[];
  enforcedBy: string | null;
  onValueChange: (reasons: string[]) => void;
}) {
  const [typed, setTyped] = useState('');

  function add(): void {
    const value = typed.trim();
    if (value.length < 2 || reasons.some((reason) => reason.toLowerCase() === value.toLowerCase()) || reasons.length >= 30) return;
    onValueChange([...reasons, value]);
    setTyped('');
  }

  return (
    <SettingsRow
      layout="full"
      label="Reasons"
      htmlFor="return-reason-add"
      description={`${enforcedBy === null ? 'Nothing reads this yet.' : `Read by ${enforcedBy}.`} The last reason cannot be removed — a return without one is a return nobody can report on.`}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-2">
          {reasons.map((reason) => (
            <Badge key={reason} variant="outline" className="gap-1 pr-1">
              {reason}
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove ${reason}`}
                disabled={reasons.length <= 1}
                onClick={() => {
                  onValueChange(reasons.filter((value) => value !== reason));
                }}
              >
                <XIcon />
              </Button>
            </Badge>
          ))}
        </div>
        <div className="flex gap-2">
          <Input
            id="return-reason-add"
            placeholder="Add a reason"
            value={typed}
            maxLength={60}
            onChange={(event) => {
              setTyped(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              add();
            }}
          />
          <Button variant="outline" onClick={add} disabled={typed.trim().length < 2}>
            Add
          </Button>
        </div>
      </div>
    </SettingsRow>
  );
}
