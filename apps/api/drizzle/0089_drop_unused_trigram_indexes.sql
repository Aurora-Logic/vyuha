-- 0088 added three GIN trigram indexes and claimed Postgres could use them
-- "for both the substring and the fuzzy half". It cannot use them for either,
-- and the claim was never checked with EXPLAIN.
--
-- The fuzzy branch is `word_similarity(term, lower(name)) >= 0.35`. pg_trgm
-- only reaches a GIN index through the `<%` operator, which reads its bound
-- from the `pg_trgm.word_similarity_threshold` GUC; a function call compared
-- with `>=` is not an indexable operator at all. The indexes were also built
-- on `name` while the predicate reads `lower(name)`, so the expressions do
-- not match either. EXPLAIN on this database returns `Seq Scan` for the
-- substring half as well.
--
-- So they were three indexes paid for on every insert and update of parties,
-- stock items and companies, delivering nothing. Dropped.
--
-- The scan is the accepted trade-off `master-query.ts` already documents for
-- its stripped branch: these are master tables of hundreds to low thousands
-- of rows and the cost is not measurable. If one ever reaches a size where it
-- is, the fix is an index on the expression actually used --
-- `gin (lower(name) gin_trgm_ops)` -- plus rewriting the predicate to `<%`
-- and setting the threshold GUC per connection. That is real work and should
-- be done when a profile asks for it, not in advance.
--
-- pg_trgm itself stays: `word_similarity` is a function from it.
DROP INDEX IF EXISTS parties_name_trgm_idx;--> statement-breakpoint
DROP INDEX IF EXISTS stock_items_name_trgm_idx;--> statement-breakpoint
DROP INDEX IF EXISTS crm_companies_name_trgm_idx;
