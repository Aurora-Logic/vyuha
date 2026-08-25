import { Fragment, useState } from 'react';
import { ArrowDownIcon, ArrowUpIcon, CaretDownIcon, CaretUpIcon } from '@phosphor-icons/react';
import {
  DASHBOARD_KPI_METRICS,
  REPORT_DEFINITIONS,
  SALES_ANALYSIS_DIMENSIONS,
  SALES_ANALYSIS_DIMENSION_LABELS,
  isReportKey,
  type DashboardKey,
  type DashboardKpiMetric,
  type DashboardLayout,
  type DashboardTile,
  type DashboardTileForm,
  type ReportDefinition,
  type ReportFilters,
  type ReportKey,
  type SalesAnalysisDimension,
} from '@vyuha/shared';
import type { DateRange } from 'react-day-picker';

import { ACTION_ICONS } from '@/components/shared/action-icons';
import { SectionHeading } from '@/components/shared/section-heading';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemGroup,
  ItemSeparator,
  ItemTitle,
} from '@/components/ui/item';
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
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { useIsMobile } from '@/hooks/use-mobile';

import { useReportCatalogue } from './api';
import { FormGallery } from './dashboard-form-gallery';
import { FORM_LABELS } from './dashboard-form-labels';
import { DASHBOARD_KPIS, kpiTileOf } from './dashboard-kpis';
import { useResetDashboardLayout, useSaveDashboardLayout } from './use-dashboard-layouts';

/**
 * The board's customise surface (owner, 25 Aug 2026): which report tiles it
 * shows, in what order, and how each one draws. The add list comes from the
 * report catalogue the server serves this person -- never from a client list
 * of keys -- so nobody can add a tile their permissions cannot render.
 */

/** The tile as the sheet edits it: the label always a string so the Input stays controlled. */
interface DraftTile {
  readonly reportKey: ReportKey;
  readonly label: string;
  readonly form: DashboardTileForm;
  readonly kind: 'chart' | 'kpi';
  readonly metric?: DashboardKpiMetric;
  readonly wide: boolean;
  readonly filters: ReportFilters;
}

function fromTile(tile: DashboardTile): DraftTile {
  return {
    reportKey: tile.reportKey,
    label: tile.label ?? '',
    form: tile.form,
    kind: tile.kind,
    ...(tile.metric === undefined ? {} : { metric: tile.metric }),
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
    kind: draft.kind,
    ...(draft.metric === undefined ? {} : { metric: draft.metric }),
    wide: draft.wide,
    filters: cleanedFilters(draft.filters),
    ...(label === '' ? {} : { label }),
  };
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
  range,
}: {
  board: DashboardKey;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The draft's starting point: the stored layout, the preset, or the overview's KPI seed. */
  current: DashboardLayout | null;
  hasStored: boolean;
  /** The board's own period, so a tile's chart previews draw the rows the board would. */
  range: DateRange;
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
            range={range}
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
  range,
  onClose,
}: {
  board: DashboardKey;
  current: DashboardLayout | null;
  hasStored: boolean;
  range: DateRange;
  onClose: () => void;
}) {
  // Two drafts, one save: the headline figures keep their own order among
  // themselves and always precede the charts in the stored list, which is
  // also how the board renders them.
  const [kpis, setKpis] = useState<DraftTile[]>(() =>
    (current?.tiles ?? []).filter((tile) => tile.kind === 'kpi').map(fromTile),
  );
  const [tiles, setTiles] = useState<DraftTile[]>(() =>
    (current?.tiles ?? []).filter((tile) => tile.kind === 'chart').map(fromTile),
  );
  const count = kpis.length + tiles.length;
  // Which tile's chart gallery is expanded, by position. One at a time: a
  // dozen live previews per open gallery is the budget, not per tile.
  const [galleryAt, setGalleryAt] = useState<number | null>(null);
  const catalogue = useReportCatalogue();
  // One set of the report keys this person may open, for the figure grid:
  // a figure whose report the catalogue lacks would save fine and then never
  // render, so the sheet disables it and says why instead.
  const catalogueKeys = new Set((catalogue.data ?? []).map((definition) => definition.key));
  const save = useSaveDashboardLayout();
  const reset = useResetDashboardLayout();
  const busy = save.isPending || reset.isPending;
  const failure = save.error ?? reset.error;

  const byCategory = new Map<string, ReportDefinition[]>();
  for (const definition of catalogue.data ?? []) {
    const list = byCategory.get(definition.category);
    if (list === undefined) byCategory.set(definition.category, [definition]);
    else list.push(definition);
  }
  const groups = [...byCategory.entries()];

  function move(index: number, delta: -1 | 1): void {
    // The open gallery is addressed by position, and after a move or a
    // removal that position names a different tile -- closing beats showing
    // one report's previews under another report's row.
    setGalleryAt(null);
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
    setGalleryAt(null);
    setTiles((list) => list.filter((_, at) => at !== index));
  }

  function add(reportKey: ReportKey): void {
    if (count >= 24) return;
    setTiles((list) => [...list, { reportKey, label: '', form: 'auto', kind: 'chart', wide: false, filters: {} }]);
  }

  function toggleMetric(metric: DashboardKpiMetric): void {
    setKpis((list) => {
      const at = list.findIndex((tile) => tile.metric === metric);
      if (at !== -1) return list.filter((_, index) => index !== at);
      if (count >= 24) return list;
      return [...list, fromTile(kpiTileOf(metric))];
    });
  }

  function moveMetric(index: number, delta: -1 | 1): void {
    setKpis((list) => {
      const target = index + delta;
      if (target < 0 || target >= list.length) return list;
      const next = [...list];
      const [item] = next.splice(index, 1);
      if (item === undefined) return list;
      next.splice(target, 0, item);
      return next;
    });
  }

  function handleSave(): void {
    if (count === 0 || busy) return;
    save.mutate(
      { dashboard: board, config: { tiles: [...kpis, ...tiles].map(toTile) } },
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
          <QueryErrorAlert
            error={failure}
            subject="the board"
            onRetry={save.error !== null ? handleSave : handleReset}
          />
        ) : null}

        <section className="flex flex-col gap-3">
          <SectionHeading
            title="Headline figures"
            note="The strip above the charts, in the order below."
          />
          {/* The same toggle-tile grid the bottom-nav chooser uses: a figure
              is on the board or it is not, and the grid says which without a
              second list to cross-read. */}
          <div className="grid grid-cols-2 gap-2">
            {DASHBOARD_KPI_METRICS.map((metric) => {
              const chosen = kpis.some((tile) => tile.metric === metric);
              const reachable = catalogueKeys.has(DASHBOARD_KPIS[metric].reportKey);
              return (
                <Button
                  key={metric}
                  type="button"
                  variant={chosen ? 'default' : 'outline'}
                  aria-pressed={chosen}
                  disabled={busy || !reachable || (!chosen && count >= 24)}
                  onClick={() => {
                    toggleMetric(metric);
                  }}
                  className="h-auto min-h-11 flex-col items-start justify-center gap-0.5 px-2 py-1.5 text-left whitespace-normal"
                >
                  <span className="min-w-0 text-xs leading-tight">
                    {DASHBOARD_KPIS[metric].label}
                  </span>
                  {reachable ? null : (
                    <span className="text-muted-foreground min-w-0 text-[0.6875rem] leading-tight">
                      Needs access to {REPORT_DEFINITIONS[DASHBOARD_KPIS[metric].reportKey].label}
                    </span>
                  )}
                </Button>
              );
            })}
          </div>
          {kpis.length > 1 ? (
            <ItemGroup role="presentation" className="gap-0 border">
              {kpis.map((draft, index) => {
                const label = draft.metric === undefined ? '' : DASHBOARD_KPIS[draft.metric].label;
                return (
                  <Fragment key={draft.metric}>
                    {index > 0 ? <ItemSeparator className="my-0" /> : null}
                    <Item size="sm" className="min-h-11 rounded-none">
                      <ItemContent className="min-w-0">
                        <ItemTitle className="w-full min-w-0">
                          <span className="min-w-0 truncate">{label}</span>
                        </ItemTitle>
                      </ItemContent>
                      <ItemActions className="gap-0">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Move ${label} up`}
                          disabled={busy || index === 0}
                          onClick={() => {
                            moveMetric(index, -1);
                          }}
                        >
                          <ArrowUpIcon />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Move ${label} down`}
                          disabled={busy || index === kpis.length - 1}
                          onClick={() => {
                            moveMetric(index, 1);
                          }}
                        >
                          <ArrowDownIcon />
                        </Button>
                      </ItemActions>
                    </Item>
                  </Fragment>
                );
              })}
            </ItemGroup>
          ) : null}
        </section>

        {tiles.length === 0 ? (
          <p className="text-muted-foreground border px-3 py-2.5 text-xs">
            No chart tiles yet. Add a report below; the board needs at least one tile or figure to
            save.
          </p>
        ) : (
          <ItemGroup role="presentation" className="gap-0 border">
            {tiles.map((draft, index) => (
              <Fragment key={`${String(index)}-${draft.reportKey}`}>
                {index > 0 ? <ItemSeparator className="my-0" /> : null}
                <TileRow
                  index={index}
                  draft={draft}
                  first={index === 0}
                  last={index === tiles.length - 1}
                  busy={busy}
                  range={range}
                  galleryOpen={galleryAt === index}
                  onToggleGallery={() => {
                    setGalleryAt((at) => (at === index ? null : index));
                  }}
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
              </Fragment>
            ))}
          </ItemGroup>
        )}

        <section className="flex flex-col gap-3">
          <SectionHeading
            title="Add a report"
            note="Only reports your permissions can open are offered."
          />
          <Select
            value={null}
            onValueChange={(next: string | null) => {
              if (next !== null && isReportKey(next)) add(next);
            }}
          >
            <SelectTrigger
              aria-label="Add a report"
              className="w-full"
              disabled={catalogue.isPending || count >= 24}
            >
              <SelectValue>
                {(value: string | null) =>
                  count >= 24
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
            <QueryErrorAlert
              error={catalogue.error}
              subject="the report list"
              onRetry={() => {
                void catalogue.refetch();
              }}
            />
          ) : null}
        </section>
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
          <Button disabled={count === 0 || busy} onClick={handleSave}>
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
  range,
  galleryOpen,
  onToggleGallery,
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
  range: DateRange;
  galleryOpen: boolean;
  onToggleGallery: () => void;
  onChange: (patch: Partial<DraftTile>) => void;
  onUp: () => void;
  onDown: () => void;
  onRemove: () => void;
}) {
  const definition = REPORT_DEFINITIONS[draft.reportKey];
  const filterNames = definition.filters as readonly string[];
  const wideId = `tile-wide-${String(index)}`;

  return (
    <Item size="sm" className="min-h-11 flex-col items-stretch gap-2 rounded-none">
      <SectionHeading
        title={definition.label}
        action={
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
        }
      />

      <Input
        aria-label={`Label for ${definition.label}`}
        placeholder={definition.label}
        value={draft.label}
        onChange={(event) => {
          onChange({ label: event.target.value });
        }}
      />

      <div className="flex flex-wrap items-center gap-2">
        {/* Collapsed to the current form's name so the tile rows stay
            scannable; expanding trades that row's compactness for the
            gallery of live previews below. */}
        <Button
          type="button"
          variant="outline"
          aria-expanded={galleryOpen}
          aria-label={`Chart form for ${definition.label}: ${FORM_LABELS[draft.form]}`}
          onClick={onToggleGallery}
        >
          Chart: {FORM_LABELS[draft.form]}
          {galleryOpen ? (
            <CaretUpIcon data-icon="inline-end" />
          ) : (
            <CaretDownIcon data-icon="inline-end" />
          )}
        </Button>

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

      {galleryOpen ? (
        <FormGallery
          reportKey={draft.reportKey}
          definition={definition}
          form={draft.form}
          range={range}
          onPick={(next) => {
            onChange({ form: next });
          }}
        />
      ) : null}
    </Item>
  );
}
