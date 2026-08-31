CREATE TABLE "cfo_alert_snoozes" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"alert_key" text NOT NULL,
	"party_id" uuid,
	"until" text NOT NULL,
	"reason" text NOT NULL,
	"snoozed_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cfo_alert_snoozes" ADD CONSTRAINT "cfo_alert_snoozes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cfo_alert_snoozes_idx" ON "cfo_alert_snoozes" USING btree ("org_id","alert_key","party_id");