CREATE TABLE "customer_tier_assignments" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"tier_code" text NOT NULL,
	"effective_from" text NOT NULL,
	"effective_to" text,
	"assigned_by" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_tiers" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"colour_token" text NOT NULL,
	"credit_days" integer,
	"credit_limit" numeric(16, 2),
	"max_discount_pct" numeric(5, 2),
	"contact_every_days" integer,
	"service_priority" text DEFAULT '' NOT NULL,
	"review_every" text DEFAULT 'Quarterly' NOT NULL,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer_tier_assignments" ADD CONSTRAINT "customer_tier_assignments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_tiers" ADD CONSTRAINT "customer_tiers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_tier_assignments_party_idx" ON "customer_tier_assignments" USING btree ("org_id","party_id","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_tiers_code_uq" ON "customer_tiers" USING btree ("org_id","code");