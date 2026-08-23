import { HANDLING_MARK_LABELS, code128, type DocumentDesign, type DocumentProfile } from '@vyuha/shared';

import { HANDLING_MARK_ICONS } from '@/components/shared/entity-icons';

import { cn } from '@/lib/utils';

import type { PaperModel } from './paper';

/**
 * The packing slip (D-47): one sheet per box, stuck on the carton or put
 * inside it. It is read by a loader at arm's length and by a transporter
 * at a counter, so the four things they look for are the biggest: who it
 * goes to, which box of how many, the order, and the barcode. The LR,
 * transporter and vehicle are write-in boxes because they are known at the
 * door, not at packing. Black on white — it prints on stickers.
 *
 * The same component draws A5 (the default) and A4; only the grid's
 * proportions and the item table's detail change.
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
  return `${date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}, ${date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
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

export function PackingSlipPaper({ design, profile, orgName, logoUrl, model, box, className }: PackingSlipPaperProps) {
  const a4 = design.paperSize === 'A4';
  // The right of the header is the number and barcode, so the logo rides the
  // left with the name and address regardless of a left/right setting; 'none'
  // still hides it, the one escape hatch for a colour logo on a thermal sticker.
  const logo =
    logoUrl !== null && design.logoPlacement !== 'none' ? (
      <img src={logoUrl} alt="" className={cn('max-h-[10mm] max-w-[26mm] shrink-0 object-contain', a4 && 'max-h-[14mm] max-w-[34mm]')} />
    ) : null;
  const note = model.type === 'DELIVERY_NOTE';
  const businessName = profile.legalName.trim() === '' ? orgName : profile.legalName;
  const addressLines = profile.addressLines.split('\n').filter((l) => l.trim() !== '');
  const shipName = (model.shipTo?.name ?? '').trim() || model.buyer.name;
  const shipAddress = ((model.shipTo?.address ?? '').trim() || model.buyer.address).split('\n').filter((l) => l.trim() !== '');
  const number = model.number ?? 'Draft';
  const boxCount = model.slip?.boxCount ?? 1;
  const lines = model.lines;
  const shown = lines;
  const units = lines.reduce((sum, line) => sum + (Number(line.quantity) || 0), 0);

  return (
    <div
      data-size={design.paperSize}
      className={cn('slip-paper mx-auto flex flex-col gap-[4mm] p-[8mm] shadow-sm ring-1 ring-black/5', a4 && 'gap-[6mm] p-[12mm]', className)}
      aria-label={note ? `Delivery note ${number}` : `Packing slip ${number}, box ${String(box)} of ${String(boxCount)}`}
    >
      <header className="flex items-start justify-between gap-[6mm] border-b-2 border-[#111] pb-[3mm]">
        <div className="flex min-w-0 items-start gap-[3mm]">
          {logo}
          <div className="flex min-w-0 flex-col gap-[1mm]">
            <b className={cn('text-[13pt] leading-tight tracking-tight', a4 && 'text-[15pt]')}>{businessName}</b>
            <small className="text-[8pt] leading-snug text-[#444]">
              {addressLines.join(', ')}
              {profile.gstin.trim() === '' ? '' : ` · GSTIN ${profile.gstin}`}
              {profile.phone.trim() === '' ? '' : ` · ${profile.phone}`}
              {a4 && profile.email.trim() !== '' ? ` · ${profile.email}` : ''}
            </small>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-[1mm] text-right">
          <span className="text-[9pt] font-bold tracking-[0.14em] uppercase">{note ? 'Delivery note' : 'Packing slip'}</span>
          <span className="tabular-nums text-[16pt] font-bold">{number}</span>
          <Barcode value={number} className={a4 ? 'h-[16mm]' : 'h-[12mm]'} />
        </div>
      </header>

      <section className="grid grid-cols-[1fr_auto] gap-[4mm]">
        <div className="min-w-0">
          <div className="mb-[1mm] text-[7.5pt] font-semibold tracking-[0.12em] text-[#444] uppercase">Ship to</div>
          <div className={cn('text-[15pt] leading-tight font-bold', a4 && 'text-[19pt]')}>{shipName}</div>
          <div className={cn('mt-[1.5mm] text-[10pt] leading-snug', a4 && 'text-[11.5pt]')}>
            {shipAddress.map((line) => (
              <div key={line}>{line}</div>
            ))}
            {model.slip?.phone ? <div className="tabular-nums">{model.slip.phone}</div> : null}
          </div>
        </div>
        {note ? (
          <div className="flex min-w-[30mm] flex-col items-center justify-center border-2 border-[#111] px-[4mm] py-[2mm] text-center">
            <span className="text-[7pt] font-bold tracking-[0.14em] uppercase">Dispatched</span>
            <span className={cn('tabular-nums text-[13pt] leading-tight font-bold', a4 && 'text-[16pt]')}>{model.date.split('-').reverse().join('-')}</span>
            <span className="text-[8pt] text-[#444]">{model.statusLabel ?? ''}</span>
          </div>
        ) : (
          <div className="flex min-w-[30mm] flex-col items-center justify-center border-2 border-[#111] px-[4mm] py-[2mm]">
            <span className="text-[7pt] font-bold tracking-[0.14em] uppercase">Box</span>
            <span className={cn('tabular-nums text-[30pt] leading-none font-bold', a4 && 'text-[40pt]')}>{box}</span>
            <span className="text-[9pt] text-[#444]">of {boxCount}</span>
          </div>
        )}
      </section>

      <section className={cn('grid grid-cols-2 gap-x-[5mm] gap-y-[2mm] border-y border-[#111] py-[2.5mm] text-[9pt]', a4 && 'grid-cols-4 text-[10pt]')}>
        <Fact label="Order">
          <span className="tabular-nums">{model.details.buyersOrderNo ?? model.reference ?? ''}{model.details.buyersOrderDate ? ` · ${model.details.buyersOrderDate}` : ''}</span>
        </Fact>
        {note ? (
          <>
            <Fact label="LR number" write={!(model.details.dispatchDocNo ?? '').trim()}>
              <span className="tabular-nums">{model.details.dispatchDocNo ?? ''}</span>
            </Fact>
            <Fact label="Dispatched through" write={!(model.details.dispatchedThrough ?? '').trim()}>{model.details.dispatchedThrough ?? ''}</Fact>
            <Fact label="Destination" write={!(model.details.destination ?? '').trim()}>{model.details.destination ?? ''}</Fact>
            {model.validUntil ? <Fact label="Expected"><span className="tabular-nums">{model.validUntil.split('-').reverse().join('-')}</span></Fact> : a4 ? <Fact label="Expected" write /> : null}
          </>
        ) : (
          <>
            <Fact label="Packed">
              <span className="tabular-nums">{formatPacked(model.slip?.packedAt ?? model.date)}</span>
              {model.slip?.packedByName ? ` · ${model.slip.packedByName}` : ''}
            </Fact>
            <Fact label="LR number" write />
            <Fact label={a4 ? 'Transporter' : 'Vehicle / transporter'} write />
            {a4 ? <Fact label="Vehicle" write /> : null}
            {a4 ? <Fact label="Driver / contact" write /> : null}
          </>
        )}
      </section>

      <section className={cn('text-[9pt]', a4 && 'text-[10pt]')}>
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
            {shown.map((line, index) => (
              <tr key={line.key}>
                {a4 ? <td className="tabular-nums border-b border-[#ddd] py-[1.3mm] pr-[2mm]">{index + 1}</td> : null}
                <td className="border-b border-[#ddd] py-[1.3mm]">{line.description}</td>
                {a4 ? <td className="tabular-nums border-b border-[#ddd] py-[1.3mm] pr-[2mm]">{line.hsnCode}</td> : null}
                <td className="tabular-nums border-b border-[#ddd] py-[1.3mm] text-right whitespace-nowrap">
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

      <footer className="mt-auto flex flex-col gap-[3mm] pt-[3mm]">
        {/* The marks the organisation switched on: a bordered band a loader
            reads across the room (owner, 22 Aug) - big glyph over its word,
            the mark is the mark, no tick-boxes. */}
        {design.handlingMarks.length > 0 ? (
          <div className="grid auto-cols-fr grid-flow-col items-stretch gap-0 border-2 border-[#111] divide-x-2 divide-[#111]">
            {design.handlingMarks.map((mark) => {
              const Glyph = HANDLING_MARK_ICONS[mark];
              return (
                <span key={mark} className="flex flex-col items-center justify-center gap-[1.5mm] px-[2mm] py-[2.5mm] text-center text-[8pt] leading-tight font-bold uppercase tracking-[0.04em]">
                  <Glyph weight="bold" className={cn('size-[9mm]', a4 && 'size-[12mm]')} aria-hidden />
                  {HANDLING_MARK_LABELS[mark]}
                </span>
              );
            })}
          </div>
        ) : null}
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
            <span className="tabular-nums mt-[0.5mm] text-[8pt] tracking-[0.18em]">{number}</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

function Fact({ label, write = false, children }: { label: string; write?: boolean; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-[0.5mm]">
      <span className="text-[7pt] font-semibold tracking-[0.12em] text-[#444] uppercase">{label}</span>
      <span className={cn('font-semibold', write && 'min-h-[5mm] border-b border-[#999]')}>{children}</span>
    </div>
  );
}
