-- Owner, 31 Aug 2026: the five fields a pipeline review asks for.
--
-- drizzle-kit also wanted to re-add every party, voucher and voucher_line
-- column here. Those are 0068's, delivered to fresh databases by 0068 itself
-- and to databases that were already past it by 0081 -- the snapshot chain
-- simply never recorded them, because the branch that wrote them carried its
-- own snapshot. Re-adding them without IF NOT EXISTS would fail on every
-- database that has them, which is all of them; the generated snapshot beside
-- this file now records them, so no later migration asks again.
CREATE TYPE "public"."crm_deal_priority" AS ENUM('low', 'normal', 'high', 'urgent');--> statement-breakpoint
ALTER TABLE "crm_deals" ADD COLUMN "lead_source" text;--> statement-breakpoint
ALTER TABLE "crm_deals" ADD COLUMN "priority" "crm_deal_priority";--> statement-breakpoint
ALTER TABLE "crm_deals" ADD COLUMN "next_follow_up_date" date;--> statement-breakpoint
ALTER TABLE "crm_deals" ADD COLUMN "competitor" text;--> statement-breakpoint
ALTER TABLE "crm_deals" ADD COLUMN "loss_reason" text;
