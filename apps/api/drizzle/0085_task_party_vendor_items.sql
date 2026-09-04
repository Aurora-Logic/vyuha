CREATE TABLE "task_items" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"item_name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "party_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "party_name" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "vendor_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "vendor_name" text;--> statement-breakpoint
ALTER TABLE "task_items" ADD CONSTRAINT "task_items_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_items" ADD CONSTRAINT "task_items_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_items" ADD CONSTRAINT "task_items_item_id_stock_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."stock_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_items_task_idx" ON "task_items" USING btree ("org_id","task_id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "task_items_unique_idx" ON "task_items" USING btree ("task_id","item_id") WHERE deleted_at IS NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_party_id_parties_id_fk" FOREIGN KEY ("party_id") REFERENCES "public"."parties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_vendor_id_parties_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."parties"("id") ON DELETE set null ON UPDATE no action;