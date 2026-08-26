CREATE TABLE "customer_owner_map" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"owner_ref" text NOT NULL,
	"share" integer DEFAULT 100 NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fact_sales_daily" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"date" date NOT NULL,
	"party_id" uuid,
	"party_name" text DEFAULT '' NOT NULL,
	"item_id" uuid,
	"item_name" text DEFAULT '' NOT NULL,
	"brand" text DEFAULT 'Unbranded' NOT NULL,
	"business_line" text DEFAULT 'DOMESTIC' NOT NULL,
	"salesperson_ref" text DEFAULT 'UNASSIGNED' NOT NULL,
	"voucher_type" text NOT NULL,
	"qty" numeric(18, 3) DEFAULT '0' NOT NULL,
	"gross" numeric(16, 2) DEFAULT '0' NOT NULL,
	"discount" numeric(16, 2) DEFAULT '0' NOT NULL,
	"returns" numeric(16, 2) DEFAULT '0' NOT NULL,
	"rate_diff" numeric(16, 2) DEFAULT '0' NOT NULL,
	"net" numeric(16, 2) DEFAULT '0' NOT NULL,
	"landed_cost" numeric(16, 2),
	"pocket_margin" numeric(16, 2),
	"voucher_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer_owner_map" ADD CONSTRAINT "customer_owner_map_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_owner_map" ADD CONSTRAINT "customer_owner_map_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_sales_daily" ADD CONSTRAINT "fact_sales_daily_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_sales_daily" ADD CONSTRAINT "fact_sales_daily_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_owner_map_party_idx" ON "customer_owner_map" USING btree ("org_id","party_id","effective_from");--> statement-breakpoint
CREATE INDEX "fact_sales_daily_date_idx" ON "fact_sales_daily" USING btree ("org_id","date");--> statement-breakpoint
CREATE INDEX "fact_sales_daily_party_idx" ON "fact_sales_daily" USING btree ("org_id","party_id","date");--> statement-breakpoint
CREATE INDEX "fact_sales_daily_item_idx" ON "fact_sales_daily" USING btree ("org_id","item_id","date");--> statement-breakpoint
CREATE INDEX "fact_sales_daily_person_idx" ON "fact_sales_daily" USING btree ("org_id","salesperson_ref","date");