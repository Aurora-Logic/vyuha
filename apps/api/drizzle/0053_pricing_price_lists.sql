CREATE TYPE "public"."price_basis" AS ENUM('rate', 'discount_pct', 'both');--> statement-breakpoint
CREATE TYPE "public"."price_list_state" AS ENUM('draft', 'pending_approval', 'active', 'superseded', 'expired');--> statement-breakpoint
CREATE TABLE "price_list_assignments" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"price_list_id" uuid NOT NULL,
	"party_id" uuid,
	"party_group" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_list_assignments_one_target" CHECK (((party_id IS NOT NULL)::int + (party_group IS NOT NULL)::int + (is_default)::int) = 1)
);
--> statement-breakpoint
CREATE TABLE "price_list_lines" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"price_list_id" uuid NOT NULL,
	"stock_item_id" uuid,
	"item_group" text,
	"basis" "price_basis" NOT NULL,
	"rate" numeric(16, 2),
	"discount_pct" numeric(5, 2),
	"min_qty" numeric(16, 3),
	"max_qty" numeric(16, 3),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_list_lines_target" CHECK (stock_item_id IS NOT NULL OR item_group IS NOT NULL),
	CONSTRAINT "price_list_lines_basis_values" CHECK ((basis = 'discount_pct' AND discount_pct IS NOT NULL) OR (basis = 'rate' AND rate IS NOT NULL) OR (basis = 'both' AND rate IS NOT NULL AND discount_pct IS NOT NULL)),
	CONSTRAINT "price_list_lines_slab_order" CHECK (min_qty IS NULL OR max_qty IS NULL OR min_qty < max_qty)
);
--> statement-breakpoint
CREATE TABLE "price_lists" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"supersedes_id" uuid,
	"state" "price_list_state" DEFAULT 'draft' NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"notes" text,
	"approval_request_id" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "price_lists_effective_order" CHECK (effective_to IS NULL OR effective_from <= effective_to),
	CONSTRAINT "price_lists_version_positive" CHECK (version >= 1)
);
--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD COLUMN "price_list_id" uuid;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD COLUMN "price_list_version" integer;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD COLUMN "resolved_rate" numeric(16, 2);--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD COLUMN "applied_discount_pct" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "sales_document_lines" ADD COLUMN "price_list_id" uuid;--> statement-breakpoint
ALTER TABLE "sales_document_lines" ADD COLUMN "price_list_version" integer;--> statement-breakpoint
ALTER TABLE "sales_document_lines" ADD COLUMN "resolved_rate" numeric(16, 2);--> statement-breakpoint
ALTER TABLE "sales_document_lines" ADD COLUMN "applied_discount_pct" numeric(5, 2);--> statement-breakpoint
ALTER TABLE "sales_document_lines" ADD COLUMN "rate_override_reason" text;--> statement-breakpoint
ALTER TABLE "price_list_assignments" ADD CONSTRAINT "price_list_assignments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_assignments" ADD CONSTRAINT "price_list_assignments_price_list_id_price_lists_id_fk" FOREIGN KEY ("price_list_id") REFERENCES "public"."price_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_assignments" ADD CONSTRAINT "price_list_assignments_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_lines" ADD CONSTRAINT "price_list_lines_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_lines" ADD CONSTRAINT "price_list_lines_price_list_id_price_lists_id_fk" FOREIGN KEY ("price_list_id") REFERENCES "public"."price_lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_list_lines" ADD CONSTRAINT "price_list_lines_stock_item_id_stock_items_id_fk" FOREIGN KEY ("stock_item_id") REFERENCES "public"."stock_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_lists" ADD CONSTRAINT "price_lists_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "price_list_assignments_list_idx" ON "price_list_assignments" USING btree ("price_list_id");--> statement-breakpoint
CREATE INDEX "price_list_assignments_org_party_idx" ON "price_list_assignments" USING btree ("org_id","party_id");--> statement-breakpoint
CREATE UNIQUE INDEX "price_list_assignments_list_party_uq" ON "price_list_assignments" USING btree ("price_list_id","party_id");--> statement-breakpoint
CREATE INDEX "price_list_lines_list_idx" ON "price_list_lines" USING btree ("price_list_id");--> statement-breakpoint
CREATE INDEX "price_list_lines_org_item_idx" ON "price_list_lines" USING btree ("org_id","stock_item_id");--> statement-breakpoint
CREATE INDEX "price_lists_org_state_idx" ON "price_lists" USING btree ("org_id","state") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "price_lists_org_name_idx" ON "price_lists" USING btree ("org_id","name") WHERE deleted_at IS NULL;