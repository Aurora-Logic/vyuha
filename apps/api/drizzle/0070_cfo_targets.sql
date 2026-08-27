CREATE TABLE "cfo_targets" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"owner_ref" text NOT NULL,
	"month" text NOT NULL,
	"net_target" numeric(16, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cfo_targets" ADD CONSTRAINT "cfo_targets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cfo_targets_owner_month_uq" ON "cfo_targets" USING btree ("org_id","owner_ref","month");--> statement-breakpoint
CREATE INDEX "cfo_targets_month_idx" ON "cfo_targets" USING btree ("org_id","month");