CREATE TABLE "portal_access_log" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"link_key_id" uuid,
	"party_id" uuid,
	"view" text NOT NULL,
	"outcome" text NOT NULL,
	"ip" text,
	"user_agent" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal_link_keys" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"party_id" uuid NOT NULL,
	"key_hash" text NOT NULL,
	"issued_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"revoke_reason" text,
	"last_used_at" timestamp with time zone,
	"view_count" integer DEFAULT 0 NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "portal_link_keys_revocation_reasoned" CHECK (revoked_at IS NULL OR revoke_reason IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "portal_access_log" ADD CONSTRAINT "portal_access_log_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_access_log" ADD CONSTRAINT "portal_access_log_link_key_id_portal_link_keys_id_fk" FOREIGN KEY ("link_key_id") REFERENCES "public"."portal_link_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_access_log" ADD CONSTRAINT "portal_access_log_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_link_keys" ADD CONSTRAINT "portal_link_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_link_keys" ADD CONSTRAINT "portal_link_keys_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portal_access_log_org_at_idx" ON "portal_access_log" USING btree ("org_id","at");--> statement-breakpoint
CREATE INDEX "portal_access_log_key_idx" ON "portal_access_log" USING btree ("link_key_id");--> statement-breakpoint
CREATE UNIQUE INDEX "portal_link_keys_hash_uq" ON "portal_link_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "portal_link_keys_party_live_uq" ON "portal_link_keys" USING btree ("org_id","party_id") WHERE deleted_at IS NULL AND revoked_at IS NULL;--> statement-breakpoint
CREATE INDEX "portal_link_keys_org_party_idx" ON "portal_link_keys" USING btree ("org_id","party_id") WHERE deleted_at IS NULL;