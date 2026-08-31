CREATE TABLE "cfo_desk_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"owner_ref" text NOT NULL,
	"outcome" text NOT NULL,
	"amount" numeric(16, 2),
	"next_date" text,
	"notes" text DEFAULT '' NOT NULL,
	"logged_on" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cfo_desk_served" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"served_on" text NOT NULL,
	"score" numeric(5, 1) NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cfo_desk_outcomes" ADD CONSTRAINT "cfo_desk_outcomes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cfo_desk_served" ADD CONSTRAINT "cfo_desk_served_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cfo_desk_outcomes_party_idx" ON "cfo_desk_outcomes" USING btree ("org_id","party_id","logged_on");--> statement-breakpoint
CREATE UNIQUE INDEX "cfo_desk_served_day_uq" ON "cfo_desk_served" USING btree ("org_id","served_on","party_id");