-- The nightly inbox prune matches `received_at < ... AND payload IS NULL`.
-- The only index that touched those columns was
-- `sync_inbox_deferred_idx (connection_id, received_at) WHERE payload IS NOT NULL`
-- -- the exact complement of this predicate -- so every sweep sequentially
-- scanned the whole inbox to find the rows it had already delivered.
--
-- Partial on the same condition the prune uses, so it holds only the rows
-- that are candidates and stays small: a row leaves this index the moment it
-- is pruned, and never enters it while its payload is still deferred.
CREATE INDEX IF NOT EXISTS sync_inbox_prune_idx
  ON sync_inbox (received_at)
  WHERE payload IS NULL;
