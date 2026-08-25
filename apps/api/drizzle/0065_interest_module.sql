CREATE TABLE "interest_build_state" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"built_through" date NOT NULL,
	"built_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interest_daily_party" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"date" date NOT NULL,
	"closing" numeric(18, 2) NOT NULL,
	"within_credit" numeric(18, 2) NOT NULL,
	"overdue" numeric(18, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interest_daily_stock" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"stock_item_id" uuid NOT NULL,
	"date" date NOT NULL,
	"quantity" numeric(18, 3) NOT NULL,
	"closing_value" numeric(18, 2) NOT NULL,
	"funded_value" numeric(18, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interest_party_settings" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"interest_rate_override" numeric(6, 2),
	"credit_days_override" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "interest_build_state" ADD CONSTRAINT "interest_build_state_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interest_daily_party" ADD CONSTRAINT "interest_daily_party_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interest_daily_party" ADD CONSTRAINT "interest_daily_party_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interest_daily_stock" ADD CONSTRAINT "interest_daily_stock_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interest_daily_stock" ADD CONSTRAINT "interest_daily_stock_stock_item_id_stock_items_id_fk" FOREIGN KEY ("stock_item_id") REFERENCES "public"."stock_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interest_party_settings" ADD CONSTRAINT "interest_party_settings_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interest_party_settings" ADD CONSTRAINT "interest_party_settings_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "interest_build_state_org_uq" ON "interest_build_state" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "interest_daily_party_uq" ON "interest_daily_party" USING btree ("org_id","party_id","date");--> statement-breakpoint
CREATE INDEX "interest_daily_party_date_idx" ON "interest_daily_party" USING btree ("org_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "interest_daily_stock_uq" ON "interest_daily_stock" USING btree ("org_id","stock_item_id","date");--> statement-breakpoint
CREATE INDEX "interest_daily_stock_date_idx" ON "interest_daily_stock" USING btree ("org_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "interest_party_settings_uq" ON "interest_party_settings" USING btree ("org_id","party_id") WHERE deleted_at IS NULL;