import { useState } from 'react';
import { ArrowDownIcon, ArrowUpIcon, WarningCircleIcon } from '@phosphor-icons/react';
import {
  DASHBOARD_TILE_FORMS,
  REPORT_DEFINITIONS,
  SALES_ANALYSIS_DIMENSIONS,
  SALES_ANALYSIS_DIMENSION_LABELS,
  isReportKey,
  type DashboardKey,
  type DashboardLayout,
  type DashboardTile,
  type DashboardTileForm,
  type ReportDefinition,
  type ReportFilters,
  type ReportKey,
  type SalesAnalysisDimension,
} from '@vyuha/shared';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { actionErrorCopy } from '@/features/leave/api-error-copy';
import { useIsMobile } from '@/hooks/use-mobile';

import { useReportCatalogue } from './api';
import { wearableForms } from './report-series';
import { useResetDashboardLayout, useSaveDashboardLayout } from './use-dashboard-layouts';

/**
 * The board's customise surface (owner, 25 Aug 2026): which report tiles it
 * shows, in what order, and how each one draws. The add list comes from the
 * report catalogue the server serves this person -- never from a client list
 * of keys -- so nobody can add a tile their permissions cannot render.
 */

const FORM_LABELS: Record<DashboardTileForm, string> = {
  auto: 'Automatic',
  hbar: 'Bars',
  line: 'Line',
  donut: 'Donut',
  scatter: 'Scatter',
  heatmap: 'Heatmap',
  radials: 'Radials',
  pareto: 'Pareto',
};

/** The tile as the sheet edits it: the label always a string so the Input stays controlled. */
interface DraftTile {
  readonly reportKey: ReportKey;
  readonly label: string;
  readonly form: DashboardTileForm;
  readonly wide: boolean;
  readonly filters: ReportFilters;
}

function fromTile(tile: DashboardTile): DraftTile {
  return {
    reportKey: tile.reportKey,
    label: tile.label ?? '',
    form: tile.form,
    wide: tile.wide,
    filters: tile.filters,
  };
}

/** Half-typed text filters would fail the server's min-length after trimming, so they are dropped. */
function cleanedFilters(filters: ReportFilters): ReportFilters {
  const next = { ...filters };
  if (next.itemName !== undefined && next.itemName.trim() === '') delete next.itemName;
  if (next.voucherType !== undefined && next.voucherType.trim() === '') delete next.voucherType;
  return next;
}

function toTile(draft: DraftTile): DashboardTile {
  const label = draft.label.trim();
  return {
    reportKey: draft.reportKey,
    form: draft.form,
    wide: draft.wide,
    filters: cleanedFilters(draft.filters),
    ...(label === '' ? {} : { label }),
  };
}

function isTileForm(value: string): value is DashboardTileForm {
  return (DASHBOARD_TILE_FORMS as readonly string[]).includes(value);
}

function isDimension(value: string): value is SalesAnalysisDimension {
  return (SALES_ANALYSIS_DIMENSIONS as readonly string[]).includes(value);
}

export function DashboardCustomiseSheet({
  board,
  open,
  onOpenChange,
  current,
  hasStored,
}: {
  board: DashboardKey;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What the board shows right now: the stored layout, the preset, or null for the bespoke overview. */
  current: DashboardLayout | null;
  hasStored: boolean;
}) {
  const isMobile = useIsMobile();
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={isMobile ? 'bottom' : 'right'}
        className="gap-0 sm:max-w-md max-md:max-h-[90vh]"
      >
        <SheetHeader className="shrink-0 border-b">
          <SheetTitle>Customise board</SheetTitle>
          <SheetDescription>
            Choose the tiles this board shows, their order, and how each one draws. The layout is
            yours alone.
          </SheetDescription>
        </SheetHeader>
        {open ? (
          <CustomiseBody
            key={board}
            board={board}
            current={current}
            hasStored={hasStored}
            onClose={() => {
              onOpenChange(false);
            }}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function CustomiseBody({
  board,
  current,
  hasStored,
  onClose,
}: {
  board: DashboardKey;
  current: DashboardLayout | null;
  hasStored: boolean;
  onClose: () => void;
}) {
  const [tiles, setTiles] = useState<DraftTile[]>(() => (current?.tiles ?? []).map(fromTile));
  const catalogue = useReportCatalogue();
  const save = useSaveDashboardLayout();
  const reset = useResetDashboardLayout();
  const busy = save.isPending || reset.isPending;
  const failure = save.error ?? reset.error;
  const copy = actionErrorCopy(failure, 'Changing the board');

  const byCategory = new Map<string, ReportDefinition[]>();
  for (const definition of catalogue.data ?? []) {
    const list = byCategory.get(definition.category);
    if (list === undefined) byCategory.set(definition.category, [definition]);
    else list.push(definition);
  }
  const groups = [...byCategory.entries()];

  function move(index: number, delta: -1 | 1): void {
    setTiles((list) => {
      const target = index + delta;
      if (target < 0 || target >= list.length) return list;
      const next = [...list];
      const [item] = next.splice(index, 1);
      if (item === undefined) return list;
      next.splice(target, 0, item);
      return next;
    });
  }

  function update(index: number, patch: Partial<DraftTile>): void {
    setTiles((list) => list.map((tile, at) => (at === index ? { ...tile, ...patch } : tile)));
  }

  function remove(index: number): void {
    setTiles((list) => list.filter((_, at) => at !== index));
  }

  function add(reportKey: ReportKey): void {
    setTiles((list) =>
      list.length >= 24
        ? list
        : [...list, { reportKey, label: '', form: 'auto', wide: false, filters: {} }],
    );
  }

  function handleSave(): void {
    if (tiles.length === 0 || busy) return;
    save.mutate(
      { dashboard: board, config: { tiles: tiles.map(toTile) } },
      {
        onSuccess: () => {
          toast.add({ type: 'success', title: 'Board saved' });
          onClose();
        },
      },
    );
  }

  function handleReset(): void {
    if (busy) return;
    reset.mutate(board, {
      onSuccess: () => {
        toast.add({
          type: 'success',
          title: board === 'overview' ? 'Back to the shipped page' : 'Back to the shipped preset',
        });
        onClose();
      },
    });
  }

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        {failure ? (
          <Alert variant="destructive">
            <WarningCircleIcon />
            <AlertTitle>{copy.title}</AlertTitle>
            <AlertDescription>{copy.description}</AlertDescription>
          </Alert>
        ) : null}

        {tiles.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No tiles yet. Add a report below; the board needs at least one to save.
          </p>
        ) : (
          <ul className="divide-y border">
            {tiles.map((draft, index) => (
              <TileRow
                key={`${String(index)}-${draft.reportKey}`}
                index={index}
                draft={draft}
                first={index === 0}
                last={index === tiles.length - 1}
                busy={busy}
                onChange={(patch) => {
                  update(index, patch);
                }}
                onUp={() => {
                  move(index, -1);
                }}
                onDown={() => {
                  move(index, 1);
                }}
                onRemove={() => {
                  remove(index);
                }}
              />
            ))}
          </ul>
        )}

        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Add a report</span>
          <Select
            value={null}
            onValueChange={(next: string | null) => {
              if (next !== null && isReportKey(next)) add(next);
            }}
          >
            <SelectTrigger
              aria-label="Add a report"
              className="w-full"
              disabled={catalogue.isPending || tiles.length >= 24}
            >
              <SelectValue>
                {(value: string | null) =>
                  tiles.length >= 24
                    ? 'This board is full'
                    : value !== null && isReportKey(value)
                      ? REPORT_DEFINITIONS[value].label
                      : 'Choose a report'
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {groups.map(([category, definitions]) => (
                <SelectGroup key={category}>
                  <SelectLabel>{category}</SelectLabel>
                  {definitions.map((definition) => (
                    <SelectItem key={definition.key} value={definition.key}>
                      {definition.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
          {catalogue.isError ? (
            <p className="text-destructive text-xs">The report list could not be loaded.</p>
          ) : null}
        </div>
      </div>

      <SheetFooter className="shrink-0 flex-row items-center gap-2 border-t">
        <Button variant="outline" disabled={!hasStored || busy} onClick={handleReset}>
          {reset.isPending ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <ACTION_ICONS.discard data-icon="inline-start" />
          )}
          Reset to preset
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" onClick={onClose}>
            <ACTION_ICONS.cancel data-icon="inline-start" />
            Cancel
          </Button>
          <Button disabled={tiles.length === 0 || busy} onClick={handleSave}>
            {save.isPending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <ACTION_ICONS.save data-icon="inline-start" />
            )}
            Save
          </Button>
        </div>
      </SheetFooter>
    </>
  );
}

function TileRow({
  index,
  draft,
  first,
  last,
  busy,
  onChange,
  onUp,
  onDown,
  onRemove,
}: {
  index: number;
  draft: DraftTile;
  first: boolean;
  last: boolean;
  busy: boolean;
  onChange: (patch: Partial<DraftTile>) => void;
  onUp: () => void;
  onDown: () => void;
  onRemove: () => void;
}) {
  const definition = REPORT_DEFINITIONS[draft.reportKey];
  const filterNames = definition.filters as readonly string[];
  const wideId = `tile-wide-${String(index)}`;

  return (
    <li className="flex flex-col gap-2 px-3 py-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{definition.label}</span>
        <span className="flex items-center">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Move ${definition.label} up`}
            disabled={busy || first}
            onClick={onUp}
          >
            <ArrowUpIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Move ${definition.label} down`}
            disabled={busy || last}
            onClick={onDown}
          >
            <ArrowDownIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${definition.label}`}
            disabled={busy}
            onClick={onRemove}
          >
            <ACTION_ICONS.remove />
          </Button>
        </span>
      </div>

      <Input
        aria-label={`Label for ${definition.label}`}
        placeholder={definition.label}
        value={draft.label}
        onChange={(event) => {
          onChange({ label: event.target.value });
        }}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={draft.form}
          onValueChange={(next: string | null) => {
            if (next !== null && isTileForm(next)) onChange({ form: next });
          }}
        >
          <SelectTrigger aria-label={`Chart form for ${definition.label}`} className="w-32">
            <SelectValue>{(current: DashboardTileForm) => FORM_LABELS[current]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {(['auto', ...wearableForms(definition)] as DashboardTileForm[]).map((form) => (
                <SelectItem key={form} value={form}>
                  {FORM_LABELS[form]}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>

        <Label htmlFor={wideId} className="flex items-center gap-1.5 text-xs font-normal">
          <Switch
            id={wideId}
            checked={draft.wide}
            disabled={busy}
            onCheckedChange={(next: boolean) => {
              onChange({ wide: next });
            }}
          />
          Wide
        </Label>

        {filterNames.includes('groupBy') ? (
          <Select
            value={draft.filters.groupBy ?? 'party'}
            onValueChange={(next: string | null) => {
              const filters = { ...draft.filters };
              if (next === null || next === 'party' || !isDimension(next)) delete filters.groupBy;
              else filters.groupBy = next;
              onChange({ filters });
            }}
          >
            <SelectTrigger aria-label={`Group ${definition.label} by`} className="w-32">
              <SelectValue>
                {(current: SalesAnalysisDimension) => SALES_ANALYSIS_DIMENSION_LABELS[current]}
              </SelectValue>
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

        {filterNames.includes('itemName') ? (
          <Input
            aria-label={`Item filter for ${definition.label}`}
            placeholder="Item name"
            className="w-40"
            value={draft.filters.itemName ?? ''}
            onChange={(event) => {
              const filters = { ...draft.filters };
              if (event.target.value === '') delete filters.itemName;
              else filters.itemName = event.target.value;
              onChange({ filters });
            }}
          />
        ) : null}

        {filterNames.includes('voucherType') ? (
          <Input
            aria-label={`Voucher type filter for ${definition.label}`}
            placeholder="Voucher type"
            className="w-40"
            value={draft.filters.voucherType ?? ''}
            onChange={(event) => {
              const filters = { ...draft.filters };
              if (event.target.value === '') delete filters.voucherType;
              else filters.voucherType = event.target.value;
              onChange({ filters });
            }}
          />
        ) : null}
      </div>
    </li>
  );
}
