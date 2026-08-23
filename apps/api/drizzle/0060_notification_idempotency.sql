CREATE TABLE "notification_idempotency" (
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_idempotency_org_id_key_pk" PRIMARY KEY("org_id","key")
);
--> statement-breakpoint
ALTER TABLE "notification_idempotency" ADD CONSTRAINT "notification_idempotency_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_idempotency_age_idx" ON "notification_idempotency" USING btree ("created_at");