CREATE TYPE "public"."duplicate_cluster_state" AS ENUM('open', 'sent_to_tally', 'dismissed', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."duplicate_entity_type" AS ENUM('party', 'stock_item');--> statement-breakpoint
CREATE TABLE "duplicate_cluster_members" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"cluster_id" uuid NOT NULL,
	"entity_type" "duplicate_entity_type" NOT NULL,
	"entity_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "duplicate_clusters" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"entity_type" "duplicate_entity_type" NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"matched_fields" text NOT NULL,
	"state" "duplicate_cluster_state" DEFAULT 'open' NOT NULL,
	"signature" text NOT NULL,
	"member_count" integer NOT NULL,
	"dismissed_reason" text,
	"dismissed_by" uuid,
	"dismissed_at" timestamp with time zone,
	"sent_to_tally_by" uuid,
	"sent_to_tally_at" timestamp with time zone,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "duplicate_cluster_members" ADD CONSTRAINT "duplicate_cluster_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duplicate_cluster_members" ADD CONSTRAINT "duplicate_cluster_members_cluster_id_duplicate_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."duplicate_clusters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duplicate_clusters" ADD CONSTRAINT "duplicate_clusters_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "duplicate_cluster_members_cluster_idx" ON "duplicate_cluster_members" USING btree ("cluster_id");--> statement-breakpoint
CREATE INDEX "duplicate_cluster_members_org_entity_idx" ON "duplicate_cluster_members" USING btree ("org_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "duplicate_clusters_org_type_state_idx" ON "duplicate_clusters" USING btree ("org_id","entity_type","state");--> statement-breakpoint
CREATE UNIQUE INDEX "duplicate_clusters_org_signature_uq" ON "duplicate_clusters" USING btree ("org_id","signature");