import { describeConstraint } from '../../../platform/db/pg-error.js';

/**
 * The sentences behind the rules sales_document_lines keeps (see the CHECK
 * constraints in sales.schema.ts). The database decides; these are what a
 * person reads when it refuses. D-48: the flow is pick, pack, invoice,
 * dispatch, and each step takes only what the one before it released.
 */
describeConstraint('sales_document_lines_picked_le_ordered', 'A line cannot pick more than was ordered. Refresh the order and look again.');
describeConstraint('sales_document_lines_packed_le_picked', 'A line packs only what has been picked. Pick it first, then pack.');
describeConstraint('sales_document_lines_invoiced_le_packed', 'A line invoices only what has been packed. Pack it first.');
describeConstraint('sales_document_lines_dispatched_le_invoiced', 'A line dispatches only what has been invoiced. Link the invoice first.');
describeConstraint('sales_documents_one_replacement_per_return_uq', 'That return already has a replacement order.');
