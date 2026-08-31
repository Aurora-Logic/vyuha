-- Merge convergence (30 Aug 2026). Two branches both wrote a migration
-- numbered 0068: 0068_party_and_voucher_detail here, 0068_custom_reports on
-- phase-6a. Both files are kept and the journal orders them by authorship,
-- but drizzle applies only entries newer than the last one a database ran,
-- so any database that followed phase-6a is already past this timestamp and
-- would skip the party and voucher columns for good. Restating them here
-- lets every database converge on its next migrate. Every statement is
-- IF NOT EXISTS, so this is a no-op wherever 0068 already ran.
ALTER TABLE "parties" ADD COLUMN IF NOT EXISTS "gst_registration_type" text;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN IF NOT EXISTS "state" text;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN IF NOT EXISTS "country" text;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN IF NOT EXISTS "pincode" text;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN IF NOT EXISTS "contact_person" text;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN IF NOT EXISTS "closing_balance" numeric;--> statement-breakpoint
ALTER TABLE "parties" ADD COLUMN IF NOT EXISTS "bill_wise_tracking" boolean;--> statement-breakpoint
ALTER TABLE "voucher_lines" ADD COLUMN IF NOT EXISTS "settlement_type" text;--> statement-breakpoint
ALTER TABLE "voucher_lines" ADD COLUMN IF NOT EXISTS "settlement_mode" text;--> statement-breakpoint
ALTER TABLE "voucher_lines" ADD COLUMN IF NOT EXISTS "instrument_number" text;--> statement-breakpoint
ALTER TABLE "voucher_lines" ADD COLUMN IF NOT EXISTS "instrument_date" date;--> statement-breakpoint
ALTER TABLE "voucher_lines" ADD COLUMN IF NOT EXISTS "bank_name" text;--> statement-breakpoint
ALTER TABLE "voucher_lines" ADD COLUMN IF NOT EXISTS "payment_favouring" text;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "reference" text;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "reference_date" date;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "order_ref" text;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "buyer_order_number" text;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "buyer_order_date" date;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "payment_terms" text;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "delivery_terms" text;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "dispatched_through" text;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "dispatch_doc_no" text;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "vehicle_number" text;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "destination" text;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "buyer_name" text;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "buyer_address" text;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "party_gstin" text;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "party_state" text;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "place_of_supply" text;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "consignee_name" text;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "consignee_state" text;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "consignee_pincode" text;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "consignee_gstin" text;