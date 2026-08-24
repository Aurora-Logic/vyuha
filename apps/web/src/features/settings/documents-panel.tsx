import { useState } from 'react';

import { Skeleton } from '@/components/ui/skeleton';
import { QueryErrorAlert } from '@/features/attendance/query-error';
import { DesignRail } from '@/features/documents/design-rail';
import { DocumentPaper, type PaperModel } from '@/features/documents/paper';
import { PackingSlipPaper } from '@/features/documents/packing-slip-paper';
import { SLIP_PAPER_TYPES } from '@/features/documents/paper-support';
import { useDocumentSettings, useFooterLogoUrls, useSaveDocumentSettings } from '@/features/documents/use-document-settings';
import { useBranding } from '@/lib/branding/use-branding';
import { usePermission } from '@/lib/session/permissions';
import { toast } from '@/components/ui/toast';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Field, FieldLabel } from '@/components/ui/field';
import { PERMISSIONS, PRINTED_DOCUMENT_TITLES, PRINTED_DOCUMENT_TYPES, type DocumentSettings, type PrintedDocumentType } from '@vyuha/shared';

/**
 * Settings → Documents: everything a printed page can be, in one place —
 * the design per document type, and the business details and bank saved
 * once for all of them — beside a sample page that shows every change as
 * it is made. The same rail the document pages open on request; here it
 * has room, and an administrator's key.
 */

const SAMPLE: Omit<PaperModel, 'type'> = {
  number: 'EST-0042',
  statusLabel: 'Draft',
  date: '2026-08-19',
  validUntil: '2026-09-18',
  buyer: { name: 'Kiran Enterprises', address: '12th Cross\nBangalore', gstin: '29AAFFC8126N1ZZ', stateName: 'Karnataka', stateCode: '29' },
  shipTo: null,
  details: { paymentTerms: '30 days', dispatchedThrough: 'By road' },
  reference: null,
  lines: [
    { key: 's1', stockItemId: null, description: '12MM Cable', hsnCode: '1005', quantity: '7.000', unit: 'No', rate: '500.00', discountPct: '0.00', taxPct: '18.00', amount: '3500.00', taxAmount: '630.00' },
    { key: 's2', stockItemId: null, description: 'Junction box', hsnCode: '8536', quantity: '2.000', unit: 'No', rate: '1200.00', discountPct: '5.00', taxPct: '18.00', amount: '2280.00', taxAmount: '410.40' },
  ],
  totals: { subtotal: '5780.00', discountTotal: '120.00', taxTotal: '1040.40', grandTotal: '6820.40', preview: false },
  notes: '',
  terms: 'Payment within 30 days of invoice.',
};

export function DocumentsPanel() {
  const settings = useDocumentSettings();
  const branding = useBranding();
  const save = useSaveDocumentSettings();
  const canSave = usePermission(PERMISSIONS.SETTINGS_MANAGE);
  const [docType, setDocType] = useState<PrintedDocumentType>('INVOICE');
  const [draft, setDraft] = useState<DocumentSettings | null>(null);
  const [base, setBase] = useState<DocumentSettings | null>(null);
  const footerLogoUrls = useFooterLogoUrls(draft?.profile.footerLogoFileIds ?? []);
  if (settings.data !== undefined && base !== settings.data) {
    // Adopt what the server holds, unless this screen has unsaved edits of its own.
    setBase(settings.data);
    if (draft === null || JSON.stringify(draft) === JSON.stringify(base)) setDraft(settings.data);
  }
  if (settings.isError) {
    return (
      <QueryErrorAlert
        error={settings.error}
        subject="document settings"
        onRetry={() => {
          void settings.refetch();
        }}
      />
    );
  }
  if (draft === null || settings.data === undefined) {
    return (
      <div role="status" aria-busy="true" aria-label="Loading document settings" className="grid gap-4 lg:grid-cols-[24rem_1fr]">
        <Skeleton className="h-96" />
        <Skeleton className="h-96" />
      </div>
    );
  }
  const saved = settings.data;
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  return (
    <div className="grid gap-6 lg:grid-cols-[24rem_minmax(0,1fr)]">
      <div className="flex min-h-[70vh] flex-col border">
        <div className="border-b p-4">
          <Field>
            <FieldLabel htmlFor="documents-type">Document</FieldLabel>
            <Select value={docType} onValueChange={(value: string | null) => { if (value !== null && (PRINTED_DOCUMENT_TYPES as readonly string[]).includes(value)) setDocType(value as PrintedDocumentType); }}>
              <SelectTrigger id="documents-type" className="w-full" aria-label="Document type">
                <SelectValue>{(value: string) => PRINTED_DOCUMENT_TITLES[value as PrintedDocumentType]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {PRINTED_DOCUMENT_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {PRINTED_DOCUMENT_TITLES[type]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <div className="min-h-0 flex-1">
          <DesignRail
            docType={docType}
            settings={draft}
            onChange={setDraft}
            canSave={canSave}
            dirty={dirty}
            saving={save.isPending}
            saveError={save.error}
            onSave={() => {
              save.mutate(draft, {
                onSuccess: () => {
                  toast.add({ type: 'success', title: 'Document settings saved', description: 'Every printed page uses them now.' });
                },
              });
            }}
            onDiscard={() => {
              setDraft(saved);
            }}
          />
        </div>
      </div>
      <div className="bg-muted/40 min-w-0 overflow-auto p-4">
        <div className="mx-auto w-fit max-w-full [zoom:0.8]">
          {SLIP_PAPER_TYPES.includes(docType) ? (
            // The goods papers have their own paper; the sample carries a three-box packing so the box badge reads.
            <PackingSlipPaper
              design={draft.designs[docType]}
              profile={draft.profile}
              orgName={branding.data?.name ?? ''}
              logoUrl={branding.data?.logoUrl ?? null}
              model={{ ...SAMPLE, type: docType, slip: { boxCount: 3, packedAt: '2026-08-19T10:30:00.000Z', packedByName: 'Asha Rao', phone: '98200 11223' } }}
              box={1}
            />
          ) : (
            <DocumentPaper design={draft.designs[docType]} profile={draft.profile} logoUrl={branding.data?.logoUrl ?? null} footerLogoUrls={footerLogoUrls} orgName={branding.data?.name ?? ''} model={{ ...SAMPLE, type: docType, copyLabel: docType === 'INVOICE' ? 'Original for Recipient' : null }} />
          )}
        </div>
      </div>
    </div>
  );
}
