CREATE TYPE "public"."replacement_charge" AS ENUM('chargeable', 'free');--> statement-breakpoint
CREATE TYPE "public"."return_condition" AS ENUM('sealed', 'opened', 'damaged');--> statement-breakpoint
CREATE TYPE "public"."return_disposition" AS ENUM('restock', 'scrap');--> statement-breakpoint
CREATE TYPE "public"."return_state" AS ENUM('awaiting_credit_note', 'credited', 'cancelled');--> statement-breakpoint
CREATE TABLE "sales_return_attachments" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"return_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sales_return_credit_notes" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"return_id" uuid NOT NULL,
	"voucher_id" uuid NOT NULL,
	"method" text NOT NULL,
	"linked_by" uuid,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_return_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"return_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"source_line_id" uuid,
	"stock_item_id" uuid,
	"description" text NOT NULL,
	"unit" text,
	"quantity" numeric(16, 3) NOT NULL,
	"reason" text NOT NULL,
	"reason_note" text,
	"condition" "return_condition" NOT NULL,
	"disposition" "return_disposition" NOT NULL,
	"replaced_qty" numeric(16, 3) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "sales_return_lines_qty_positive" CHECK (quantity > 0),
	CONSTRAINT "sales_return_lines_replaced_le_returned" CHECK (replaced_qty >= 0 AND replaced_qty <= quantity)
);
--> statement-breakpoint
CREATE TABLE "sales_returns" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"number" text NOT NULL,
	"state" "return_state" DEFAULT 'awaiting_credit_note' NOT NULL,
	"party_id" uuid,
	"customer_name" text NOT NULL,
	"source_document_id" uuid,
	"dispatch_id" uuid,
	"received_on" date NOT NULL,
	"received_by" uuid,
	"notes" text,
	"replacement_charge" "replacement_charge",
	"cancelled_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "sales_document_lines" DROP CONSTRAINT "sales_document_lines_dispatched_le_invoiced";--> statement-breakpoint
ALTER TABLE "sales_document_lines" ADD COLUMN "free_of_charge" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sales_documents" ADD COLUMN "return_id" uuid;--> statement-breakpoint
ALTER TABLE "sales_return_attachments" ADD CONSTRAINT "sales_return_attachments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_return_attachments" ADD CONSTRAINT "sales_return_attachments_return_id_sales_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."sales_returns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_return_attachments" ADD CONSTRAINT "sales_return_attachments_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_return_credit_notes" ADD CONSTRAINT "sales_return_credit_notes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_return_credit_notes" ADD CONSTRAINT "sales_return_credit_notes_return_id_sales_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."sales_returns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_return_credit_notes" ADD CONSTRAINT "sales_return_credit_notes_voucher_id_vouchers_id_fk" FOREIGN KEY ("voucher_id") REFERENCES "public"."vouchers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_return_lines" ADD CONSTRAINT "sales_return_lines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_return_lines" ADD CONSTRAINT "sales_return_lines_return_id_sales_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."sales_returns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_return_lines" ADD CONSTRAINT "sales_return_lines_source_line_id_sales_document_lines_id_fk" FOREIGN KEY ("source_line_id") REFERENCES "public"."sales_document_lines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_return_lines" ADD CONSTRAINT "sales_return_lines_stock_item_id_stock_items_id_fk" FOREIGN KEY ("stock_item_id") REFERENCES "public"."stock_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_source_document_id_sales_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."sales_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_dispatch_id_dispatches_id_fk" FOREIGN KEY ("dispatch_id") REFERENCES "public"."dispatches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_returns" ADD CONSTRAINT "sales_returns_received_by_employees_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sales_return_attachments_return_idx" ON "sales_return_attachments" USING btree ("return_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_return_credit_notes_voucher_uq" ON "sales_return_credit_notes" USING btree ("voucher_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_return_credit_notes_return_uq" ON "sales_return_credit_notes" USING btree ("return_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_return_lines_return_line_uq" ON "sales_return_lines" USING btree ("return_id","line_no");--> statement-breakpoint
CREATE INDEX "sales_return_lines_org_item_idx" ON "sales_return_lines" USING btree ("org_id","stock_item_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "sales_returns_org_number_uq" ON "sales_returns" USING btree ("org_id","number");--> statement-breakpoint
CREATE INDEX "sales_returns_org_state_idx" ON "sales_returns" USING btree ("org_id","state") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "sales_returns_org_party_idx" ON "sales_returns" USING btree ("org_id","party_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "sales_returns_org_received_idx" ON "sales_returns" USING btree ("org_id","received_on") WHERE deleted_at IS NULL;--> statement-breakpoint
ALTER TABLE "sales_document_lines" ADD CONSTRAINT "sales_document_lines_dispatched_le_invoiced" CHECK (dispatched_qty >= 0 AND (free_of_charge OR dispatched_qty <= invoiced_qty));