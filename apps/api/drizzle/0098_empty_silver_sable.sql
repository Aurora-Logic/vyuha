CREATE TABLE IF NOT EXISTS "interest_stock_settings" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid,
	"target_name" text NOT NULL,
	"interest_rate_override" numeric(6, 2),
	"holding_period_days_override" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "interest_stock_settings" ADD CONSTRAINT "interest_stock_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "interest_stock_settings_uq" ON "interest_stock_settings" USING btree ("org_id","target_type","target_name") WHERE deleted_at IS NULL;