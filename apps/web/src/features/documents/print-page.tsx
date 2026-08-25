import { useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { useParty } from '@/features/masters/use-parties';
import { useGrn, usePurchaseOrder } from '@/features/purchase/use-purchase';
import type { Estimate } from '@/features/sales/types';
import { useDispatch } from '@/features/sales/use-dispatches';
import { useEstimate, useSalesOrder } from '@/features/sales/use-estimates';
import { usePackRecord } from '@/features/sales/use-fulfilment';
import { useInvoice } from '@/features/sales/use-invoices';
import { useBranding } from '@/lib/branding/use-branding';
import { INVOICE_COPIES, INVOICE_COPY_LABELS, type InvoiceCopy, type PrintedDocumentType } from '@vyuha/shared';

import { PackingSlipPaper } from './packing-slip-paper';
import { SLIP_PAPER_TYPES } from './paper-support';
import { DocumentPaper } from './paper';
import { useVoucher } from '@/features/masters/use-vouchers';

import { dispatchAsPaper, grnAsPaper, packAsPaper, paperModelOf, purchaseOrderAsPaper, salesDocumentAsPaper, voucherAsPaper, type PaperRecord } from './paper-record';
import { useDocumentSettings, useFooterLogoUrls } from './use-document-settings';

/**
 * The print route: the paper and nothing else, outside the shell, so the
 * browser's print dialog — and its Save as PDF — sees an A4 page and no
 * chrome (`@page` and `.a4-paper` in index.css). Opened in its own tab from
 * a document's PDF button; prints on load, and stays open so it can be
 * printed again or saved. An invoice prints its three copies as three
 * pages, each named (GST's original, duplicate, triplicate).
 */

const KINDS: Record<string, PrintedDocumentType> = { estimates: 'ESTIMATE', orders: 'SALES_ORDER', invoices: 'INVOICE', dispatches: 'DELIVERY_NOTE', packs: 'PACKING_SLIP', 'purchase-orders': 'PURCHASE_ORDER', grns: 'RECEIPT_NOTE' };

export function DocumentPrintPage() {
  const params = useParams<{ kind: string; id: string }>();
  const [searchParams] = useSearchParams();
  const id = params.id ?? null;
  // A Tally voucher borrows a paper by its type; which one is known once the voucher is read.
  const isVoucher = params.kind === 'vouchers';
  const voucher = useVoucher(isVoucher ? id : null);
  const voucherPaperRecord = isVoucher && voucher.data !== undefined ? voucherAsPaper(voucher.data) : null;
  const type = isVoucher ? (voucherPaperRecord?.type ?? 'INVOICE') : (KINDS[params.kind ?? ''] ?? null);
  const settings = useDocumentSettings();
  const branding = useBranding();
  // One hook per kind, all mounted; only the matching one asks. The goods papers read their order as well.
  const estimate = useEstimate(!isVoucher && type === 'ESTIMATE' ? id : null);
  const order = useSalesOrder(!isVoucher && type === 'SALES_ORDER' ? id : null);
  const invoice = useInvoice(!isVoucher && type === 'INVOICE' ? id : null);
  const dispatch = useDispatch(!isVoucher && type === 'DELIVERY_NOTE' ? id : null);
  const pack = usePackRecord(!isVoucher && type === 'PACKING_SLIP' ? id : null);
  const purchaseOrder = usePurchaseOrder(!isVoucher && type === 'PURCHASE_ORDER' ? id : null);
  const grn = useGrn(!isVoucher && type === 'RECEIPT_NOTE' ? id : null);
  const sourceOrder = useSalesOrder(type === 'DELIVERY_NOTE' ? (dispatch.data?.documentId ?? null) : type === 'PACKING_SLIP' ? (pack.data?.documentId ?? null) : null);
  const sourcePo = usePurchaseOrder(type === 'RECEIPT_NOTE' ? (grn.data?.purchaseOrderId ?? null) : null);
  const query = type === 'SALES_ORDER' ? order : type === 'INVOICE' ? invoice : type === 'DELIVERY_NOTE' ? dispatch : type === 'PACKING_SLIP' ? pack : type === 'PURCHASE_ORDER' ? purchaseOrder : type === 'RECEIPT_NOTE' ? grn : estimate;
  const record: PaperRecord | undefined = isVoucher
    ? voucherPaperRecord?.record
    : type === 'PURCHASE_ORDER'
      ? purchaseOrder.data === undefined
        ? undefined
        : purchaseOrderAsPaper(purchaseOrder.data)
      : type === 'DELIVERY_NOTE'
        ? dispatch.data === undefined || sourceOrder.data === undefined
          ? undefined
          : dispatchAsPaper(dispatch.data, sourceOrder.data)
        : type === 'PACKING_SLIP'
          ? pack.data === undefined || sourceOrder.data === undefined
            ? undefined
            : packAsPaper(pack.data, sourceOrder.data)
          : type === 'RECEIPT_NOTE'
            ? grn.data === undefined || sourcePo.data === undefined
              ? undefined
              : grnAsPaper(grn.data, sourcePo.data)
            : query.data === undefined
              ? undefined
              : salesDocumentAsPaper(query.data as Estimate);
  const party = useParty(record?.partyId ?? null);
  const footerLogoUrls = useFooterLogoUrls(settings.data?.profile.footerLogoFileIds ?? []);
  const ready = record !== undefined && settings.data !== undefined && branding.data !== undefined && (record.partyId === null || party.data !== undefined || party.isError);

  useEffect(() => {
    if (!ready || searchParams.get('auto') === '0') return;
    // A frame later, so the fonts and the logo have painted before the dialog snapshots the page.
    const timer = window.setTimeout(() => {
      window.print();
    }, 400);
    return () => {
      window.clearTimeout(timer);
    };
  }, [ready, searchParams]);

  if (type === null) return <p className="p-6 text-sm">Nothing prints at this address.</p>;
  const failed = [query, sourceOrder, sourcePo].find((q) => q.isError);
  if (failed !== undefined) {
    return (
      <div className="p-6">
        <QueryErrorAlert error={failed.error} subject="that document" onRetry={() => { void failed.refetch(); }} />
      </div>
    );
  }
  if (!ready) {
    return (
      <div role="status" aria-busy="true" aria-label="Preparing the page" className="mx-auto max-w-[210mm] p-6">
        <Skeleton className="h-[297mm] w-full" />
      </div>
    );
  }
  const copies: readonly (InvoiceCopy | null)[] = type === 'INVOICE' ? INVOICE_COPIES : [null];
  const model = paperModelOf(type, record, party.data);
  const design = settings.data.designs[type];
  // D-47: the slip prints one sheet per box, on the size the design chose;
  // @page follows it so the dialog offers the sheet the slip was drawn for.
  const slip = SLIP_PAPER_TYPES.includes(type);
  const pageSize = slip ? design.paperSize : 'A4';
  // A slip prints one sheet per box; a delivery note is one sheet.
  const boxes = slip ? Array.from({ length: type === 'PACKING_SLIP' ? (model.slip?.boxCount ?? 1) : 1 }, (_, index) => index + 1) : [];
  return (
    <div className="bg-muted/40 min-h-dvh print:bg-white">
      {pageSize === 'A5' ? <style>{'@page { size: A5; margin: 0; }'}</style> : null}
      <div className="print-hidden mx-auto flex max-w-[210mm] items-center justify-between gap-2 px-4 py-3 text-sm">
        <span className="text-muted-foreground">
          Use your browser's print dialog to save this as a PDF ({pageSize}{slip && boxes.length > 1 ? `, ${String(boxes.length)} sheets — one per box` : ''}).
        </span>
        <Button size="sm" onClick={() => { window.print(); }}>
          Print or save PDF
        </Button>
      </div>
      {/* An A4 sheet on a phone scrolls inside this column, never the page (measured: 373px at 360 without it). */}
      <div className="mx-auto flex max-w-[210mm] flex-col gap-6 overflow-x-auto pb-8 print:gap-0 print:overflow-visible print:pb-0">
        {slip
          ? boxes.map((box) => (
              <PackingSlipPaper key={box} design={design} profile={settings.data.profile} orgName={branding.data.name} logoUrl={branding.data.logoUrl} model={model} box={box} />
            ))
          : null}
        {slip ? null : copies.map((copy) => (
          <DocumentPaper
            key={copy ?? 'single'}
            design={settings.data.designs[type]}
            profile={settings.data.profile}
            logoUrl={branding.data.logoUrl}
            footerLogoUrls={footerLogoUrls}
            orgName={branding.data.name}
            model={{ ...model, copyLabel: copy === null ? null : INVOICE_COPY_LABELS[copy] }}
          />
        ))}
      </div>
    </div>
  );
}
