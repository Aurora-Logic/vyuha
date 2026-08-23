ALTER TABLE "sales_document_lines" DROP CONSTRAINT "sales_document_lines_dispatched_le_invoiced";--> statement-breakpoint
ALTER TABLE "sales_document_lines" ADD CONSTRAINT "sales_document_lines_dispatched_le_invoiced" CHECK (dispatched_qty >= 0 AND dispatched_qty <= (CASE WHEN free_of_charge THEN packed_qty ELSE invoiced_qty END));
