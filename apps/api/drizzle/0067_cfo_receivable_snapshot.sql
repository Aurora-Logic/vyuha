CREATE TABLE "fact_receivable_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"snapshot_date" date NOT NULL,
	"party_id" uuid NOT NULL,
	"bill_ref" text NOT NULL,
	"bill_date" date,
	"due_date" date,
	"amount" numeric(16, 2) NOT NULL,
	"outstanding" numeric(16, 2) NOT NULL,
	"days_overdue" integer NOT NULL,
	"bucket" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fact_receivable_snapshot" ADD CONSTRAINT "fact_receivable_snapshot_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_receivable_snapshot" ADD CONSTRAINT "fact_receivable_snapshot_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fact_receivable_snapshot_uq" ON "fact_receivable_snapshot" USING btree ("org_id","snapshot_date","party_id","bill_ref");--> statement-breakpoint
CREATE INDEX "fact_receivable_snapshot_party_idx" ON "fact_receivable_snapshot" USING btree ("org_id","party_id","snapshot_date");--> statement-breakpoint
CREATE INDEX "fact_receivable_snapshot_date_idx" ON "fact_receivable_snapshot" USING btree ("org_id","snapshot_date");