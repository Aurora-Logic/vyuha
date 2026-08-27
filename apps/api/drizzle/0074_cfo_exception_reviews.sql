CREATE TABLE "cfo_exception_reviews" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"org_id" uuid NOT NULL,
	"check_key" text NOT NULL,
	"voucher_id" uuid NOT NULL,
	"state" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"reviewed_by" uuid NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cfo_exception_reviews" ADD CONSTRAINT "cfo_exception_reviews_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cfo_exception_reviews_uq" ON "cfo_exception_reviews" USING btree ("org_id","check_key","voucher_id");