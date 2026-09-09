CREATE TABLE IF NOT EXISTS "approval_settlement_outbox" (
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
CREATE TABLE IF NOT EXISTS "file_cleanup_tasks" (
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
CREATE TABLE IF NOT EXISTS "notification_outbox" (
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
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"claim_token" uuid,
	"claim_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pending_bill_allocation_sets" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"voucher_guid" text NOT NULL,
	"source_alter_id" bigint NOT NULL,
	"rows" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "request_receipts" (
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"request_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "request_receipts_org_id_user_id_operation_request_key_pk" PRIMARY KEY("org_id","user_id","operation","request_key")
);
--> statement-breakpoint
ALTER TABLE "fallback_jobs" ADD COLUMN IF NOT EXISTS "claim_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "delivery_key" text;--> statement-breakpoint
ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "voucher_kind" text;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "approval_settlement_outbox" ADD CONSTRAINT "approval_settlement_outbox_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "approval_settlement_outbox" ADD CONSTRAINT "approval_settlement_outbox_approval_request_id_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."approval_requests"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "pending_bill_allocation_sets" ADD CONSTRAINT "pending_bill_allocation_sets_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "pending_bill_allocation_sets" ADD CONSTRAINT "pending_bill_allocation_sets_connection_id_integration_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "request_receipts" ADD CONSTRAINT "request_receipts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "request_receipts" ADD CONSTRAINT "request_receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "approval_settlement_outbox_event_uq" ON "approval_settlement_outbox" USING btree ("event_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approval_settlement_outbox_pending_idx" ON "approval_settlement_outbox" USING btree ("state","run_after");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "file_cleanup_tasks_object_uq" ON "file_cleanup_tasks" USING btree ("purpose","storage_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "file_cleanup_tasks_due_idx" ON "file_cleanup_tasks" USING btree ("run_after");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_outbox_pending_idx" ON "notification_outbox" USING btree ("state","run_after");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notification_outbox_idempotency_uq" ON "notification_outbox" USING btree ("org_id","idempotency_key") WHERE idempotency_key IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pending_bill_allocation_sets_connection_voucher_uq" ON "pending_bill_allocation_sets" USING btree ("connection_id","voucher_guid");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notifications_delivery_key_uq" ON "notifications" USING btree ("org_id","delivery_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vouchers_org_kind_date_idx" ON "vouchers" USING btree ("org_id","voucher_kind","voucher_date");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sales_documents_one_replacement_per_return_uq" ON "sales_documents" USING btree ("return_id") WHERE return_id IS NOT NULL AND deleted_at IS NULL;