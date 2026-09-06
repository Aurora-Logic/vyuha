ALTER TABLE notifications ADD COLUMN delivery_key text;
--> statement-breakpoint
CREATE UNIQUE INDEX notifications_delivery_key_uq ON notifications (org_id, delivery_key);
--> statement-breakpoint
ALTER TABLE notification_outbox ADD COLUMN progress jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE notification_outbox ADD COLUMN claim_token uuid;
--> statement-breakpoint
ALTER TABLE notification_outbox ADD COLUMN claim_until timestamptz;
--> statement-breakpoint
-- Older jobs do not carry an outbox id or per-channel acknowledgements.
-- Do not automatically resend them as though nothing was ever delivered.
UPDATE notification_outbox SET state = 'LEGACY_ENQUEUED' WHERE state = 'ENQUEUED';
