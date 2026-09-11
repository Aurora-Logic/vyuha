import type { Response } from 'express';
import { PRINTED_DOCUMENT_TITLES, type DocumentSettings, type PrintedDocumentType, type PartyStatementView } from '@vyuha/shared';
import { sql } from 'drizzle-orm';

import type { Database } from '../db/db.provider.js';
import type { DocumentSettingsService } from './document-settings.service.js';
import type { DocumentSheetInput, DocumentXlsxService } from './document-xlsx.service.js';

/**
 * The Excel button behind every sales document: the same workbook, streamed
 * the same way, from any module that holds a document-shaped record.
 * A helper rather than a service so the sales and purchase modules call it
 * without a new provider — both already hold the two services it needs.
 */
export async function sendDocumentXlsx(
  res: Response,
  deps: { db: Database; settings: DocumentSettingsService; xlsx: DocumentXlsxService },
  orgId: string,
  type: PrintedDocumentType,
  doc: Pick<DocumentSheetInput, 'number' | 'date' | 'status' | 'lines' | 'notes' | 'terms'> & Partial<Pick<DocumentSheetInput, 'subtotal' | 'discountTotal' | 'taxTotal' | 'grandTotal'>> & { customerName: string; partyDetail?: string | null; reference?: string | null },
): Promise<void> {
  const [settings, org] = await Promise.all([
    deps.settings.read(orgId),
    deps.db.execute<{ name: string }>(sql`SELECT name FROM organizations WHERE id = ${orgId}`),
  ]);
  const input: DocumentSheetInput = {
    type,
    number: doc.number,
    date: doc.date,
    status: doc.status,
    partyName: doc.customerName,
    partyDetail: doc.partyDetail ?? null,
    reference: doc.reference ?? null,
    lines: doc.lines,
    subtotal: doc.subtotal ?? '0.00',
    discountTotal: doc.discountTotal ?? '0.00',
    taxTotal: doc.taxTotal ?? '0.00',
    grandTotal: doc.grandTotal ?? '0.00',
    notes: doc.notes,
    terms: doc.terms,
    // The design decides whether money prints; a delivery note's workbook lists quantities only.
    showAmounts: settings.designs[type].showAmounts,
  };
  const buffer = await deps.xlsx.build(settings.profile, org.rows[0]?.name ?? '', input);
  const filename = `${PRINTED_DOCUMENT_TITLES[type].replace(/\s+/gu, '-')}-${doc.number.replace(/[^A-Za-z0-9._-]/gu, '-')}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(buffer);
}

export { type DocumentSettings };

/** Report 48: the party's statement as a workbook, named for the party and the period. */
export async function sendStatementXlsx(
  res: Response,
  deps: { db: Database; settings: DocumentSettingsService; xlsx: DocumentXlsxService },
  orgId: string,
  statement: PartyStatementView,
): Promise<void> {
  const [settings, org] = await Promise.all([
    deps.settings.read(orgId),
    deps.db.execute<{ name: string }>(sql`SELECT name FROM organizations WHERE id = ${orgId}`),
  ]);
  const buffer = await deps.xlsx.buildStatement(settings.profile, org.rows[0]?.name ?? '', statement);
  const party = statement.party.name.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-|-$/gu, '') || 'party';
  const filename = `Statement-${party}-${statement.from}-to-${statement.to}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(buffer);
}
