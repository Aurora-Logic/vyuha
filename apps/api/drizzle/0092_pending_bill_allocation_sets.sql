-- Bill allocations may arrive before the voucher whose GUID anchors them.
-- Keep the voucher's complete set durably until that voucher is projected;
-- advancing the pull cursor must never make the rows disappear (REQ-AJ-02).
CREATE TABLE "pending_bill_allocation_sets" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"voucher_guid" text NOT NULL,
	"source_alter_id" bigint NOT NULL,
	"rows" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pending_bill_allocation_sets_rows_array" CHECK (jsonb_typeof("rows") = 'array')
);
--> statement-breakpoint
ALTER TABLE "pending_bill_allocation_sets" ADD CONSTRAINT "pending_bill_allocation_sets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pending_bill_allocation_sets" ADD CONSTRAINT "pending_bill_allocation_sets_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "pending_bill_allocation_sets_connection_voucher_uq" ON "pending_bill_allocation_sets" USING btree ("connection_id", "voucher_guid");
