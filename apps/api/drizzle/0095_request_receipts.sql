-- Additive request deduplication. Receipts hold identifiers/hashes, not response bodies.
CREATE TABLE request_receipts (
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation text NOT NULL,
  request_key text NOT NULL,
  fingerprint text NOT NULL,
  entity_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id, operation, request_key)
);
