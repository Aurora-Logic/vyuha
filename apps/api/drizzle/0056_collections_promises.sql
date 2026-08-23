CREATE TYPE "public"."promise_state" AS ENUM('open', 'kept', 'partially_kept', 'broken');--> statement-breakpoint
CREATE TABLE "collector_assignments" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"collector_id" uuid NOT NULL,
	"target_amount" numeric(16, 2),
	"period_from" date NOT NULL,
	"period_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "collector_assignments_period_order" CHECK (period_to IS NULL OR period_from <= period_to)
);
--> statement-breakpoint
CREATE TABLE "promises_to_pay" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"amount" numeric(16, 2) NOT NULL,
	"promised_date" date NOT NULL,
	"bills" text[] DEFAULT '{}'::text[] NOT NULL,
	"taken_by" uuid,
	"taken_on" date NOT NULL,
	"notes" text,
	"state" "promise_state" DEFAULT 'open' NOT NULL,
	"received_amount" numeric(16, 2) DEFAULT '0' NOT NULL,
	"received_on" date,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "promises_to_pay_amount_positive" CHECK (amount > 0)
);
--> statement-breakpoint
CREATE TABLE "reminder_notices" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"recipient" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"composed_text" text NOT NULL,
	"statement_as_of" date NOT NULL,
	"outstanding_at_send" numeric(16, 2) NOT NULL,
	"sent_at" timestamp with time zone,
	"sent_by" uuid,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "collector_assignments" ADD CONSTRAINT "collector_assignments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_assignments" ADD CONSTRAINT "collector_assignments_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_assignments" ADD CONSTRAINT "collector_assignments_collector_id_employees_id_fk" FOREIGN KEY ("collector_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promises_to_pay" ADD CONSTRAINT "promises_to_pay_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promises_to_pay" ADD CONSTRAINT "promises_to_pay_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promises_to_pay" ADD CONSTRAINT "promises_to_pay_taken_by_employees_id_fk" FOREIGN KEY ("taken_by") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_notices" ADD CONSTRAINT "reminder_notices_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminder_notices" ADD CONSTRAINT "reminder_notices_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "collector_assignments_org_party_uq" ON "collector_assignments" USING btree ("org_id","party_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "collector_assignments_org_collector_idx" ON "collector_assignments" USING btree ("org_id","collector_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "promises_to_pay_org_party_idx" ON "promises_to_pay" USING btree ("org_id","party_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "promises_to_pay_org_date_idx" ON "promises_to_pay" USING btree ("org_id","promised_date") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "reminder_notices_org_party_idx" ON "reminder_notices" USING btree ("org_id","party_id","created_at");