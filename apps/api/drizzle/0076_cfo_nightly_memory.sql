CREATE TABLE "cfo_alert_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"day" text NOT NULL,
	"alert_key" text NOT NULL,
	"party_id" uuid,
	"exposure" numeric(16, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cfo_data_quality_daily" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"day" text NOT NULL,
	"check_key" text NOT NULL,
	"value" numeric(16, 3),
	"health" numeric(5, 3),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cfo_grade_history" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"day" text NOT NULL,
	"party_id" uuid NOT NULL,
	"grade" text NOT NULL,
	"risk" numeric(5, 1) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cfo_report_schedules" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"report" text NOT NULL,
	"cadence" text NOT NULL,
	"recipients" text NOT NULL,
	"created_by" uuid NOT NULL,
	"last_run_on" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cfo_alert_evaluations" ADD CONSTRAINT "cfo_alert_evaluations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cfo_data_quality_daily" ADD CONSTRAINT "cfo_data_quality_daily_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cfo_grade_history" ADD CONSTRAINT "cfo_grade_history_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cfo_report_schedules" ADD CONSTRAINT "cfo_report_schedules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cfo_alert_evaluations_idx" ON "cfo_alert_evaluations" USING btree ("org_id","day","alert_key","party_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cfo_data_quality_daily_uq" ON "cfo_data_quality_daily" USING btree ("org_id","day","check_key");--> statement-breakpoint
CREATE UNIQUE INDEX "cfo_grade_history_uq" ON "cfo_grade_history" USING btree ("org_id","day","party_id");--> statement-breakpoint
CREATE INDEX "cfo_report_schedules_idx" ON "cfo_report_schedules" USING btree ("org_id","cadence");