-- Fence stale Postgres-fallback workers, and preserve cross-system work until
-- the queue/object-store side has durably accepted or completed it.
ALTER TABLE "fallback_jobs" ADD COLUMN "claim_generation" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE TABLE "notification_outbox" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"audience" jsonb NOT NULL,
	"payload" jsonb NOT NULL,
	"idempotency_key" text,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"enqueued_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "notification_outbox_pending_idx" ON "notification_outbox" USING btree ("state","run_after");
--> statement-breakpoint
CREATE UNIQUE INDEX "notification_outbox_idempotency_uq" ON "notification_outbox" USING btree ("org_id","idempotency_key") WHERE idempotency_key IS NOT NULL;
--> statement-breakpoint
CREATE TABLE "file_cleanup_tasks" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"purpose" "file_purpose" NOT NULL,
	"storage_key" text NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE UNIQUE INDEX "file_cleanup_tasks_object_uq" ON "file_cleanup_tasks" USING btree ("purpose","storage_key");
--> statement-breakpoint
CREATE INDEX "file_cleanup_tasks_due_idx" ON "file_cleanup_tasks" USING btree ("run_after");
--> statement-breakpoint
CREATE TABLE "approval_settlement_outbox" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"approval_request_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"decision" jsonb NOT NULL,
	"event_key" text NOT NULL,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"claim_token" uuid,
	"claimed_at" timestamp with time zone,
	"last_error" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "approval_settlement_outbox" ADD CONSTRAINT "approval_settlement_outbox_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "approval_settlement_outbox" ADD CONSTRAINT "approval_settlement_outbox_approval_request_id_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."approval_requests"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "approval_settlement_outbox_event_uq" ON "approval_settlement_outbox" USING btree ("event_key");
--> statement-breakpoint
CREATE INDEX "approval_settlement_outbox_pending_idx" ON "approval_settlement_outbox" USING btree ("state","run_after");
