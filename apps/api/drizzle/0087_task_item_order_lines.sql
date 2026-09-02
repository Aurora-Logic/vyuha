ALTER TABLE "task_items" ADD COLUMN "quantity" numeric(16, 3) DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "task_items" ADD COLUMN "rate" numeric(16, 2);--> statement-breakpoint
ALTER TABLE "task_items" ADD COLUMN "discount_pct" numeric(5, 2) DEFAULT '0' NOT NULL;