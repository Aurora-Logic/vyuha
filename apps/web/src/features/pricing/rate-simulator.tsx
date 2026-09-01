import { useState } from 'react';
import { BooksIcon, CubeIcon, TagIcon } from '@phosphor-icons/react';
import { Link } from 'react-router';

import type { PickerOption } from '@/components/shared/record-picker';
import { RecordTable, type RecordColumn } from '@/components/shared/record-table';
import { SectionHeading } from '@/components/shared/section-heading';
import { Badge } from '@/components/ui/badge';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { DateField } from '@/features/attendance/pickers';
import { fromDateParam, toDateParam } from '@/features/attendance/format';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { ItemPicker } from '@/features/masters/item-picker';
import { PartyPicker } from '@/features/masters/party-picker';
import { formatMoney } from '@/lib/format';
import { RATE_SOURCE_LABELS, type RateSimulation } from '@vyuha/shared';

import { useRateSimulation } from './use-pricing';

/**
 * 15 REQ-AN-18: pick a party and an item, see what resolves and why,
 * without raising a document. The screen support actually uses: the
 * answer, the list it came from, and every list that was considered with
 * the reason it did or did not apply.
 */

type Considered = RateSimulation['considered'][number];

const CONSIDERED_COLUMNS: RecordColumn<Considered>[] = [
  { key: 'list', header: 'Price list', cell: (row) => <Link to={`/masters/price-lists/${row.priceListId}`} className="font-medium underline-offset-4 hover:underline">{row.name} v{String(row.version)}</Link> },
  { key: 'source', header: 'Reached as', cell: (row) => RATE_SOURCE_LABELS[row.source] },
  { key: 'applied', header: 'Applied', cell: (row) => (row.applied ? <Badge>Yes</Badge> : <Badge variant="outline">No</Badge>) },
  { key: 'why', header: 'Why', cell: (row) => <span className="text-muted-foreground">{row.why}</span> },
];

export function RateSimulator() {
  const [partyId, setPartyId] = useState<string | null>(null);
  const [item, setItem] = useState<PickerOption | null>(null);
  const [quantity, setQuantity] = useState('1');
  const [date, setDate] = useState(toDateParam(new Date()));
  // PartyPicker and ItemPicker search on the server as you type. This read
  // the first 200 of each and filtered them here, so party 201 and item 201
  // could not be simulated at all.
  const [partyName, setPartyName] = useState<string | undefined>(undefined);
  const simulation = useRateSimulation({ stockItemId: item?.id ?? null, partyId: partyId ?? undefined, quantity: quantity.trim() === '' ? '1' : quantity.trim(), date });

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <PartyPicker
          id="simulate-party"
          label="Party"
          showLabel
          placeholder="Any party (the default list)"
          icon={<BooksIcon className="text-muted-foreground" />}
          partyId={partyId}
          {...(partyName === undefined ? {} : { partyName })}
          clearable
          clearLabel="No party"
          onValueChange={(next) => {
            setPartyId(next?.id ?? null);
            setPartyName(next?.name);
          }}
        />
        <ItemPicker
          id="simulate-item"
          label="Stock item"
          showLabel
          placeholder="Stock item"
          icon={<CubeIcon className="text-muted-foreground" />}
          value={item}
          onValueChange={(next) => {
            setItem(next === null ? null : { id: next.id, label: next.name });
          }}
        />
        <Field>
          <FieldLabel htmlFor="simulate-qty">Quantity</FieldLabel>
          <Input id="simulate-qty" inputMode="decimal" className="tabular-nums" value={quantity} onChange={(event) => { setQuantity(event.target.value); }} />
        </Field>
        <DateField label="Document date" showLabel value={fromDateParam(date)} onValueChange={(next) => { setDate(toDateParam(next)); }} yearsBack={5} yearsForward={1} />
      </div>

      {item === null ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <TagIcon />
            </EmptyMedia>
            <EmptyTitle>Pick an item to see its rate</EmptyTitle>
            <EmptyDescription>With a party, the answer is that party's; without one, the default list's or Tally's.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : simulation.isError ? (
        <QueryErrorAlert error={simulation.error} subject="the rate" onRetry={() => { void simulation.refetch(); }} />
      ) : simulation.data === undefined ? (
        <Skeleton className="h-32 w-full" />
      ) : (
        <Result result={simulation.data} />
      )}
    </div>
  );
}

function Result({ result }: { result: RateSimulation }) {
  return (
    <div className="flex flex-col gap-6">
      <dl className="divide-border grid grid-cols-2 divide-x divide-y border sm:grid-cols-4 sm:divide-y-0">
        <div className="flex flex-col gap-0.5 px-3 py-2">
          <dt className="text-muted-foreground text-[0.6875rem]">Resolved rate</dt>
          <dd className="text-base font-medium tabular-nums">{result.rate === null ? 'None' : formatMoney(result.rate)}</dd>
        </div>
        <div className="flex flex-col gap-0.5 px-3 py-2">
          <dt className="text-muted-foreground text-[0.6875rem]">From</dt>
          <dd className="truncate text-base font-medium">{result.priceListName === null ? RATE_SOURCE_LABELS[result.source] : `${result.priceListName} v${String(result.priceListVersion ?? 1)}`}</dd>
        </div>
        <div className="flex flex-col gap-0.5 px-3 py-2">
          <dt className="text-muted-foreground text-[0.6875rem]">Tally rate</dt>
          <dd className="text-base font-medium tabular-nums">{result.tallyRate === null ? 'None' : formatMoney(result.tallyRate)}</dd>
        </div>
        <div className="flex flex-col gap-0.5 px-3 py-2">
          <dt className="text-muted-foreground text-[0.6875rem]">Matched by</dt>
          <dd className="text-base font-medium">{result.matchedBy === null ? '—' : result.matchedBy === 'item' ? 'The item' : `The item group ${result.itemGroup}`}{result.slab ? ` · ${result.slab.minQty ?? '0'}–${result.slab.maxQty ?? 'any'}` : ''}</dd>
        </div>
      </dl>
      <p className="text-sm">{result.explanation}</p>
      {result.considered.length > 0 ? (
        <section className="flex flex-col gap-3">
          <SectionHeading title="Lists considered" note="In resolution order: the party's, its group's, the default." />
          <RecordTable columns={CONSIDERED_COLUMNS} rows={[...result.considered]} rowKey={(row) => row.priceListId} mobilePrimary={(row) => `${row.name} v${String(row.version)}`} mobileSupporting={(row) => `${row.applied ? 'Applied' : 'Not applied'} · ${row.why}`} />
        </section>
      ) : null}
    </div>
  );
}
