-- REQ-E-09: a period is closed with a reason, and reopened with one.
--
-- Migration 0011 added both CHECKs, and both were satisfied by leaving the
-- reason out entirely: `char_length(btrim(NULL)) >= 10` is NULL, and a CHECK
-- refuses only on FALSE. The rule the slice was written for -- "with a
-- reason" -- was the one thing it did not hold.
--
-- The lock reason becomes NOT NULL, which is two-valued by construction and
-- moves the rule one layer earlier, into the type. The unlock rule names the
-- null explicitly.
--
-- Both stay NOT VALID, deliberately: a period unlocked before today under the
-- old rule keeps its history rather than having a reason invented for it.
-- Every new write is checked.
ALTER TABLE "attendance_period_locks" ALTER COLUMN "lock_reason" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "attendance_period_locks" DROP CONSTRAINT IF EXISTS "attendance_period_locks_unlock_has_reason";--> statement-breakpoint
ALTER TABLE "attendance_period_locks"
  ADD CONSTRAINT "attendance_period_locks_unlock_has_reason"
  CHECK ("unlocked_at" IS NULL OR ("unlock_reason" IS NOT NULL AND char_length(btrim("unlock_reason")) >= 10)) NOT VALID;
