CREATE TABLE "cfo_brand_slabs" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"brand" text NOT NULL,
	"label" text NOT NULL,
	"threshold" numeric(16, 2) NOT NULL,
	"basis" text DEFAULT 'sales' NOT NULL,
	"period" text DEFAULT 'FY' NOT NULL,
	"reward" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cfo_brand_slabs" ADD CONSTRAINT "cfo_brand_slabs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cfo_brand_slabs_idx" ON "cfo_brand_slabs" USING btree ("org_id","brand");