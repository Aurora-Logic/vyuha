import type { ReactNode } from 'react';

import { HANDLING_MARK_LABELS, code128, type DocumentDesign, type DocumentProfile, type HandlingMark } from '@vyuha/shared';

import { HANDLING_MARK_ICONS } from '@/components/shared/entity-icons';

import { formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';

import type { PaperModel } from './paper';

/**
 * The goods papers (D-47): the packing slip that rides a carton and the
 * delivery note that travels with it, on black-on-white stock so they print
 * on stickers and thermal paper. Three layouts, chosen in the Design rail:
 *
 * - `barcode`  the balanced slip — who it goes to, which box of how many, the
 *              order, the items and a scan code, all legible at arm's length.
 * - `label`    a warehouse label — ship-to and box number set large over a big
 *              scan code, the items a compact list; read across a room.
 * - `list`     a packing list — a ruled item table with a packer's tick column
 *              under a letterhead; the sheet that goes inside the box.
 *
 * Each fills its sheet: the item area grows so the margins stay equal on all
 * four sides rather than leaving a blank band above a footer pinned to the
 * bottom. A5 by default (a carton face), A4 for a pallet.
 */

function Barcode({ value, className, label }: { value: string; className?: string; label?: string }) {
  const { bars, width } = code128(value);
  const quiet = 10;
  const height = 40;
  return (
    <svg
      viewBox={`0 0 ${String(width + quiet * 2)} ${String(height)}`}
      preserveAspectRatio="none"
      className={className}
      role="img"
      aria-label={label ?? `Barcode ${value}`}
      style={{ width: `${String((width + quiet * 2) * 0.22)}mm` }}
    >
      <rect width="100%" height="100%" fill="#fff" />
      {bars.map(([x, w]) => (
        <rect key={x} x={x + quiet} y={0} width={w} height={height} fill="#111" />
      ))}
    </svg>
  );
}

function formatPacked(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${formatDate(iso)}, ${date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
}

function Fact({ label, write = false, children }: { label: string; write?: boolean; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-[0.5mm]">
      <span className="text-[7pt] font-semibold tracking-[0.12em] text-[#444] uppercase">{label}</span>
      <span className={cn('font-semibold', write && 'min-h-[5mm] border-b border-[#999]')}>{children}</span>
    </div>
  );
}

/** The handling marks the organisation switched on, a band a loader reads across the room. */
function HandlingBand({ marks, a4 }: { marks: readonly HandlingMark[]; a4: boolean }) {
  if (marks.length === 0) return null;
  return (
    <div className="grid auto-cols-fr grid-flow-col items-stretch gap-0 border-2 border-[#111] divide-x-2 divide-[#111]">
      {marks.map((mark) => {
        const Glyph = HANDLING_MARK_ICONS[mark];
        return (
          <span key={mark} className="flex flex-col items-center justify-center gap-[1.5mm] px-[2mm] py-[2.5mm] text-center text-[8pt] leading-tight font-bold tracking-[0.04em] uppercase">
            <Glyph weight="bold" className={cn('size-[9mm]', a4 && 'size-[12mm]')} aria-hidden />
            {HANDLING_MARK_LABELS[mark]}
          </span>
        );
      })}
    </div>
  );
}

export interface PackingSlipPaperProps {
  readonly design: DocumentDesign;
  readonly profile: DocumentProfile;
  readonly orgName: string;
  /** The organisation's logo, beside the name in the header; a null url or a 'none' placement hides it. */
  readonly logoUrl: string | null;
  readonly model: PaperModel;
  /** 1-based; the slip says "Box 2 of 3". */
  readonly box: number;
  readonly className?: string;
}

/** Everything the three layouts read, derived once. */
interface SlipContext {
  readonly a4: boolean;
  readonly note: boolean;
  readonly businessName: string;
  readonly addressLines: readonly string[];
  readonly shipName: string;
  readonly shipAddress: readonly string[];
  readonly number: string;
  readonly box: number;
  readonly boxCount: number;
  readonly lines: PaperModel['lines'];
  readonly units: number;
  readonly logo: ReactNode;
  readonly model: PaperModel;
  readonly design: DocumentDesign;
  readonly profile: DocumentProfile;
}

export function PackingSlipPaper({ design, profile, orgName, logoUrl, model, box, className }: PackingSlipPaperProps) {
  const a4 = design.paperSize === 'A4';
  const note = model.type === 'DELIVERY_NOTE';
  const businessName = profile.legalName.trim() === '' ? orgName : profile.legalName;
  const addressLines = profile.addressLines.split('\n').filter((l) => l.trim() !== '');
  const shipName = (model.shipTo?.name ?? '').trim() || model.buyer.name;
  const shipAddress = ((model.shipTo?.address ?? '').trim() || model.buyer.address).split('\n').filter((l) => l.trim() !== '');
  const number = model.number ?? 'Draft';
  const boxCount = model.slip?.boxCount ?? 1;
  const lines = model.lines;
  const units = lines.reduce((sum, line) => sum + (Number(line.quantity) || 0), 0);
  const logo =
    logoUrl !== null && design.logoPlacement !== 'none' ? (
      <img src={logoUrl} alt="" className={cn('max-h-[10mm] max-w-[26mm] shrink-0 object-contain', a4 && 'max-h-[14mm] max-w-[34mm]')} />
    ) : null;

  const ctx: SlipContext = { a4, note, businessName, addressLines, shipName, shipAddress, number, box, boxCount, lines, units, logo, model, design, profile };
  const body = design.slipTemplate === 'label' ? labelBody(ctx) : design.slipTemplate === 'list' ? listBody(ctx) : barcodeBody(ctx);

  return (
    <div
      data-size={design.paperSize}
      data-slip={design.slipTemplate}
      className={cn('slip-paper mx-auto flex flex-col gap-[4mm] p-[8mm] shadow-sm ring-1 ring-black/5', a4 && 'gap-[6mm] p-[12mm]', className)}
      aria-label={note ? `Delivery note ${number}` : `Packing slip ${number}, box ${String(box)} of ${String(boxCount)}`}
    >
      {body}
    </div>
  );
}

/** The company line: name, address, GSTIN, phone (and email on A4). */
function orgLine({ profile, addressLines, a4 }: SlipContext): ReactNode {
  return (
    <>
      {addressLines.join(', ')}
      {profile.gstin.trim() === '' ? '' : ` · GSTIN ${profile.gstin}`}
      {profile.phone.trim() === '' ? '' : ` · ${profile.phone}`}
      {a4 && profile.email.trim() !== '' ? ` · ${profile.email}` : ''}
    </>
  );
}

// -------------------------------------------------------------- barcode slip

function barcodeBody(ctx: SlipContext): ReactNode {
  const { a4, note, businessName, number, box, boxCount, lines, units, logo, model, design } = ctx;
  return (
    <>
      <header className="flex items-start justify-between gap-[6mm] border-b-2 border-[#111] pb-[3mm]">
        <div className="flex min-w-0 items-start gap-[3mm]">
          {logo}
          <div className="flex min-w-0 flex-col gap-[1mm]">
            <b className={cn('text-[13pt] leading-tight tracking-tight', a4 && 'text-[15pt]')}>{businessName}</b>
            <small className="text-[8pt] leading-snug text-[#444]">{orgLine(ctx)}</small>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-[1mm] text-right">
          <span className="text-[9pt] font-bold tracking-[0.14em] uppercase">{note ? 'Delivery note' : 'Packing slip'}</span>
          <span className="text-[16pt] font-bold tabular-nums">{number}</span>
          <Barcode value={number} className={a4 ? 'h-[16mm]' : 'h-[12mm]'} />
        </div>
      </header>

      <section className="grid grid-cols-[1fr_auto] gap-[4mm]">
        <div className="min-w-0">
          <div className="mb-[1mm] text-[7.5pt] font-semibold tracking-[0.12em] text-[#444] uppercase">Ship to</div>
          <div className={cn('text-[15pt] leading-tight font-bold', a4 && 'text-[19pt]')}>{ctx.shipName}</div>
          <div className={cn('mt-[1.5mm] text-[10pt] leading-snug', a4 && 'text-[11.5pt]')}>
            {ctx.shipAddress.map((line) => (
              <div key={line}>{line}</div>
            ))}
            {model.slip?.phone ? <div className="tabular-nums">{model.slip.phone}</div> : null}
          </div>
        </div>
        {note ? <DispatchedBox ctx={ctx} /> : <BoxBadge box={box} boxCount={boxCount} a4={a4} />}
      </section>

      <section className={cn('grid grid-cols-2 gap-x-[5mm] gap-y-[2mm] border-y border-[#111] py-[2.5mm] text-[9pt]', a4 && 'grid-cols-4 text-[10pt]')}>
        <FactRow ctx={ctx} />
      </section>

      <section className={cn('flex flex-1 flex-col text-[9pt]', a4 && 'text-[10pt]')}>
        <table className="w-full border-collapse">
          <thead>
            <tr>
              {a4 ? <th className="border-b border-[#111] py-[1mm] text-left text-[7pt] font-semibold tracking-[0.1em] text-[#444] uppercase">#</th> : null}
              <th className="border-b border-[#111] py-[1mm] text-left text-[7pt] font-semibold tracking-[0.1em] text-[#444] uppercase">Item</th>
              {a4 ? <th className="border-b border-[#111] py-[1mm] text-left text-[7pt] font-semibold tracking-[0.1em] text-[#444] uppercase">HSN</th> : null}
              <th className="border-b border-[#111] py-[1mm] text-right text-[7pt] font-semibold tracking-[0.1em] text-[#444] uppercase">Qty</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => (
              <tr key={line.key}>
                {a4 ? <td className="border-b border-[#ddd] py-[1.3mm] pr-[2mm] tabular-nums">{index + 1}</td> : null}
                <td className="border-b border-[#ddd] py-[1.3mm]">{line.description}</td>
                {a4 ? <td className="border-b border-[#ddd] py-[1.3mm] pr-[2mm] tabular-nums">{line.hsnCode}</td> : null}
                <td className="border-b border-[#ddd] py-[1.3mm] text-right whitespace-nowrap tabular-nums">
                  {line.quantity}
                  {line.unit ? ` ${line.unit}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="pt-[1.5mm] text-[#444]">
          {lines.length} line{lines.length === 1 ? '' : 's'} · {units} units {note ? 'in this dispatch' : 'in this packing'}
          {a4 ? ' · quantities only, values are on the invoice' : ''}
        </p>
        {model.notes.trim() !== '' ? <p className="pt-[1mm] text-[#444]">{model.notes}</p> : null}
      </section>

      <footer className="flex flex-col gap-[3mm] pt-[3mm]">
        <HandlingBand marks={design.handlingMarks} a4={a4} />
        <div className="flex items-end justify-between gap-[4mm] border-t-2 border-[#111] pt-[2.5mm] text-[8pt] text-[#444]">
          <div>
            <b className="text-[#111]">{note ? 'Scan to mark delivered.' : 'Scan to ship or to mark delivered.'}</b>
            {a4 || note ? (
              <>
                <br />Checked by ____________________ · Receiver's name and signature ________________________________ · Date ________
              </>
            ) : null}
            <br />
            {design.footerNote.trim() === '' ? 'Vyuha' : design.footerNote}
          </div>
          <div className="flex shrink-0 flex-col items-center">
            <Barcode value={number} className={a4 ? 'h-[14mm]' : 'h-[10mm]'} label="" />
            <span className="mt-[0.5mm] text-[8pt] tracking-[0.18em] tabular-nums">{number}</span>
          </div>
        </div>
      </footer>
    </>
  );
}

// --------------------------------------------------------------- shipping label

function labelBody(ctx: SlipContext): ReactNode {
  const { a4, note, businessName, number, box, boxCount, lines, units, logo, model, design } = ctx;
  return (
    <>
      <header className="flex items-center justify-between gap-[4mm] border-b border-[#111] pb-[2mm]">
        <div className="flex min-w-0 items-center gap-[2.5mm]">
          {logo}
          <b className="truncate text-[10pt] tracking-tight">{businessName}</b>
        </div>
        <span className="text-[8pt] font-bold tracking-[0.14em] text-[#444] uppercase">{note ? 'Delivery note' : 'Packing slip'} · {number}</span>
      </header>

      <section className="grid grid-cols-[1fr_auto] items-start gap-[5mm]">
        <div className="min-w-0">
          <div className="mb-[1mm] text-[8pt] font-semibold tracking-[0.14em] text-[#444] uppercase">Ship to</div>
          <div className={cn('text-[22pt] leading-[1.05] font-bold', a4 && 'text-[30pt]')}>{ctx.shipName}</div>
          <div className={cn('mt-[2mm] text-[11pt] leading-snug', a4 && 'text-[13pt]')}>
            {ctx.shipAddress.map((line) => (
              <div key={line}>{line}</div>
            ))}
            {model.slip?.phone ? <div className="font-semibold tabular-nums">{model.slip.phone}</div> : null}
          </div>
        </div>
        {note ? <DispatchedBox ctx={ctx} big /> : <BoxBadge box={box} boxCount={boxCount} a4={a4} big />}
      </section>

      <section className="grid grid-cols-2 gap-x-[5mm] gap-y-[2mm] border-y border-[#111] py-[2.5mm] text-[10pt]">
        <FactRow ctx={ctx} />
      </section>

      <section className="flex flex-1 flex-col text-[10pt]">
        <div className="mb-[1mm] text-[7.5pt] font-semibold tracking-[0.12em] text-[#444] uppercase">Contents</div>
        <ul className="grid grid-cols-1 gap-x-[5mm] gap-y-[0.5mm] sm:grid-cols-2">
          {lines.map((line) => (
            <li key={line.key} className="flex items-baseline justify-between gap-[3mm] border-b border-[#eee] py-[0.8mm]">
              <span className="min-w-0 truncate">{line.description}</span>
              <span className="shrink-0 font-semibold tabular-nums">
                {line.quantity}
                {line.unit ? ` ${line.unit}` : ''}
              </span>
            </li>
          ))}
        </ul>
        <p className="pt-[1.5mm] text-[8.5pt] text-[#444]">
          {lines.length} line{lines.length === 1 ? '' : 's'} · {units} units {note ? 'in this dispatch' : 'in this box'}
        </p>
        {model.notes.trim() !== '' ? <p className="pt-[1mm] text-[8.5pt] text-[#444]">{model.notes}</p> : null}
      </section>

      <HandlingBand marks={design.handlingMarks} a4={a4} />

      <footer className="flex flex-col items-center gap-[1mm] border-t-2 border-[#111] pt-[2.5mm]">
        <Barcode value={number} className={a4 ? 'h-[20mm] w-full' : 'h-[16mm] w-full'} label="" />
        <span className="text-[11pt] font-bold tracking-[0.3em] tabular-nums">{number}</span>
        <span className="text-[7.5pt] text-[#444]">{note ? 'Scan to mark delivered' : 'Scan to ship or to mark delivered'}</span>
        {design.footerNote.trim() !== '' ? <span className="text-[7.5pt] text-[#444]">{design.footerNote}</span> : null}
      </footer>
    </>
  );
}

// ---------------------------------------------------------------- packing list

function listBody(ctx: SlipContext): ReactNode {
  const { a4, note, businessName, number, box, boxCount, lines, units, logo, model, design, profile } = ctx;
  return (
    <>
      <header className="flex items-start justify-between gap-[6mm] border-b-2 border-[#111] pb-[3mm]">
        <div className="flex min-w-0 items-start gap-[3mm]">
          {logo}
          <div className="flex min-w-0 flex-col gap-[0.5mm]">
            <b className="text-[13pt] leading-tight tracking-tight">{businessName}</b>
            <small className="text-[8pt] leading-snug text-[#444]">{orgLine(ctx)}</small>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-[1mm] text-right">
          <span className="text-[10pt] font-bold tracking-[0.14em] uppercase">{note ? 'Delivery note' : 'Packing list'}</span>
          <span className="text-[14pt] font-bold tabular-nums">{number}</span>
          <Barcode value={number} className="h-[10mm]" />
        </div>
      </header>

      <section className="grid grid-cols-[1fr_auto] gap-[5mm]">
        <div className="min-w-0">
          <div className="mb-[0.5mm] text-[7.5pt] font-semibold tracking-[0.12em] text-[#444] uppercase">Ship to</div>
          <div className="text-[12pt] leading-tight font-bold">{ctx.shipName}</div>
          <div className="mt-[1mm] text-[9.5pt] leading-snug">
            {ctx.shipAddress.map((line) => (
              <div key={line}>{line}</div>
            ))}
            {model.slip?.phone ? <div className="tabular-nums">{model.slip.phone}</div> : null}
          </div>
        </div>
        {note ? (
          <DispatchedBox ctx={ctx} />
        ) : (
          <div className="flex min-w-[26mm] flex-col items-center justify-center border border-[#111] px-[3mm] py-[1.5mm]">
            <span className="text-[7pt] font-bold tracking-[0.14em] uppercase">Box</span>
            <span className="text-[20pt] leading-none font-bold tabular-nums">{box}</span>
            <span className="text-[8pt] text-[#444]">of {boxCount}</span>
          </div>
        )}
      </section>

      <section className="grid grid-cols-2 gap-x-[5mm] gap-y-[2mm] border-y border-[#111] py-[2.5mm] text-[9.5pt] sm:grid-cols-4">
        <FactRow ctx={ctx} />
      </section>

      <section className="flex-1 text-[9.5pt]">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-y border-[#111]">
              <th className="py-[1.2mm] pr-[2mm] text-left text-[7pt] font-semibold tracking-[0.1em] text-[#444] uppercase">#</th>
              <th className="py-[1.2mm] text-left text-[7pt] font-semibold tracking-[0.1em] text-[#444] uppercase">Item</th>
              <th className="py-[1.2mm] pr-[2mm] text-left text-[7pt] font-semibold tracking-[0.1em] text-[#444] uppercase">HSN</th>
              <th className="py-[1.2mm] pr-[2mm] text-right text-[7pt] font-semibold tracking-[0.1em] text-[#444] uppercase">Qty</th>
              <th className="py-[1.2mm] text-center text-[7pt] font-semibold tracking-[0.1em] text-[#444] uppercase">Packed</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => (
              <tr key={line.key}>
                <td className="border-b border-[#ddd] py-[1.4mm] pr-[2mm] align-top tabular-nums">{index + 1}</td>
                <td className="border-b border-[#ddd] py-[1.4mm] align-top">{line.description}</td>
                <td className="border-b border-[#ddd] py-[1.4mm] pr-[2mm] align-top tabular-nums">{line.hsnCode}</td>
                <td className="border-b border-[#ddd] py-[1.4mm] pr-[2mm] text-right align-top whitespace-nowrap tabular-nums">
                  {line.quantity}
                  {line.unit ? ` ${line.unit}` : ''}
                </td>
                <td className="border-b border-[#ddd] py-[1.4mm] text-center align-top">
                  <span className="inline-block size-[4mm] border border-[#999]" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="pt-[1.5mm] text-[8.5pt] text-[#444]">
          {lines.length} line{lines.length === 1 ? '' : 's'} · {units} units {note ? 'in this dispatch' : 'in this packing'} · quantities only, values are on the invoice
        </p>
        {model.notes.trim() !== '' ? <p className="pt-[1mm] text-[8.5pt] text-[#444]">{model.notes}</p> : null}
      </section>

      <HandlingBand marks={design.handlingMarks} a4={a4} />

      <footer className="flex items-end justify-between gap-[4mm] border-t-2 border-[#111] pt-[2.5mm] text-[8pt] text-[#444]">
        <div className="flex flex-col gap-[3mm]">
          <div className="flex gap-[8mm]">
            <span>Packed by {model.slip?.packedByName ? <b className="text-[#111]">{model.slip.packedByName}</b> : '____________________'}</span>
            <span>Checked by ____________________</span>
          </div>
          <div className="flex gap-[8mm]">
            <span>Received by ________________________________</span>
            <span>Date ____________</span>
          </div>
          <span>{design.footerNote.trim() === '' ? `for ${businessName}` : design.footerNote}</span>
        </div>
        <div className="flex shrink-0 flex-col items-center">
          <Barcode value={number} className="h-[10mm]" label="" />
          <span className="mt-[0.5mm] text-[8pt] tracking-[0.18em] tabular-nums">{number}</span>
        </div>
      </footer>
      {profile.footerCaption.trim() !== '' ? <div className="text-center text-[7.5pt] tracking-wide text-[#444] uppercase">{profile.footerCaption}</div> : null}
    </>
  );
}

// ------------------------------------------------------------------- shared bits

function BoxBadge({ box, boxCount, a4, big = false }: { box: number; boxCount: number; a4: boolean; big?: boolean }) {
  return (
    <div className={cn('flex flex-col items-center justify-center border-2 border-[#111] px-[4mm] py-[2mm]', big ? 'min-w-[38mm]' : 'min-w-[30mm]')}>
      <span className="text-[7pt] font-bold tracking-[0.14em] uppercase">Box</span>
      <span className={cn('leading-none font-bold tabular-nums', big ? 'text-[46pt]' : 'text-[30pt]', a4 && (big ? 'text-[60pt]' : 'text-[40pt]'))}>{box}</span>
      <span className="text-[9pt] text-[#444]">of {boxCount}</span>
    </div>
  );
}

function DispatchedBox({ ctx, big = false }: { ctx: SlipContext; big?: boolean }) {
  const { a4, model } = ctx;
  return (
    <div className={cn('flex flex-col items-center justify-center border-2 border-[#111] px-[4mm] py-[2mm] text-center', big ? 'min-w-[38mm]' : 'min-w-[30mm]')}>
      <span className="text-[7pt] font-bold tracking-[0.14em] uppercase">Dispatched</span>
      <span className={cn('leading-tight font-bold tabular-nums', big ? 'text-[18pt]' : 'text-[13pt]', a4 && (big ? 'text-[22pt]' : 'text-[16pt]'))}>{formatDate(model.date)}</span>
      <span className="text-[8pt] text-[#444]">{model.statusLabel ?? ''}</span>
    </div>
  );
}

/** The facts row: order, then dispatch or packing details; write-in boxes for what is known at the door. */
function FactRow({ ctx }: { ctx: SlipContext }) {
  const { note, model, a4 } = ctx;
  if (note) {
    return (
      <>
        <Fact label="Order">
          <span className="tabular-nums">{model.details.buyersOrderNo ?? model.reference ?? ''}{model.details.buyersOrderDate ? ` · ${model.details.buyersOrderDate}` : ''}</span>
        </Fact>
        <Fact label="LR number" write={!(model.details.dispatchDocNo ?? '').trim()}>
          <span className="tabular-nums">{model.details.dispatchDocNo ?? ''}</span>
        </Fact>
        <Fact label="Dispatched through" write={!(model.details.dispatchedThrough ?? '').trim()}>{model.details.dispatchedThrough ?? ''}</Fact>
        <Fact label="Destination" write={!(model.details.destination ?? '').trim()}>{model.details.destination ?? ''}</Fact>
        {model.validUntil ? <Fact label="Expected"><span className="tabular-nums">{formatDate(model.validUntil)}</span></Fact> : a4 ? <Fact label="Expected" write /> : null}
      </>
    );
  }
  return (
    <>
      <Fact label="Order">
        <span className="tabular-nums">{model.details.buyersOrderNo ?? model.reference ?? ''}{model.details.buyersOrderDate ? ` · ${model.details.buyersOrderDate}` : ''}</span>
      </Fact>
      <Fact label="Packed">
        <span className="tabular-nums">{formatPacked(model.slip?.packedAt ?? model.date)}</span>
        {model.slip?.packedByName ? ` · ${model.slip.packedByName}` : ''}
      </Fact>
      <Fact label="LR number" write />
      <Fact label={a4 ? 'Transporter' : 'Vehicle / transporter'} write />
      {a4 ? <Fact label="Vehicle" write /> : null}
      {a4 ? <Fact label="Driver / contact" write /> : null}
    </>
  );
}
