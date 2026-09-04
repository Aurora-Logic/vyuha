-- A return's replacement order is whichever sales_documents row carries its
-- return_id, read back as "the first one, LIMIT 1". Nothing stopped two
-- concurrent decisions raising two, one of which was then invisible.
-- Partial: a soft-deleted order does not hold the slot.
CREATE UNIQUE INDEX IF NOT EXISTS sales_documents_one_replacement_per_return_uq
  ON sales_documents (return_id)
  WHERE return_id IS NOT NULL AND deleted_at IS NULL;
