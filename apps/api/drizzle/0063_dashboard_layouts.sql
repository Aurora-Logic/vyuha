-- The two period-lock statements below are 0062's, re-emitted: 0062 was
-- hand-written with no meta snapshot, so the chain believed they were never
-- applied. They are guarded the way 0062 guarded its own -- DROP IF EXISTS
-- then ADD ... NOT VALID -- so this file applies cleanly whether or not 0062
-- ran, and legacy rows keep their history instead of failing validation.
CREATE TABLE "dashboard_layouts" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"dashboard" text NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "attendance_period_locks" ALTER COLUMN "lock_reason" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "dashboard_layouts" ADD CONSTRAINT "dashboard_layouts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dashboard_layouts" ADD CONSTRAINT "dashboard_layouts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dashboard_layouts_lookup_idx" ON "dashboard_layouts" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dashboard_layouts_unique_idx" ON "dashboard_layouts" USING btree ("org_id","user_id","dashboard") WHERE deleted_at IS NULL;--> statement-breakpoint
ALTER TABLE "attendance_period_locks" DROP CONSTRAINT IF EXISTS "attendance_period_locks_lock_has_reason";--> statement-breakpoint
ALTER TABLE "attendance_period_locks" ADD CONSTRAINT "attendance_period_locks_lock_has_reason" CHECK (char_length(btrim(lock_reason)) >= 10) NOT VALID;--> statement-breakpoint
ALTER TABLE "attendance_period_locks" DROP CONSTRAINT IF EXISTS "attendance_period_locks_unlock_has_reason";--> statement-breakpoint
ALTER TABLE "attendance_period_locks" ADD CONSTRAINT "attendance_period_locks_unlock_has_reason" CHECK (unlocked_at IS NULL OR (unlock_reason IS NOT NULL AND char_length(btrim(unlock_reason)) >= 10)) NOT VALID;