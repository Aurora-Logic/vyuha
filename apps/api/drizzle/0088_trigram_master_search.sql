-- Typo tolerance for the master pickers (owner, 1 Sep 2026: "acem" should
-- find "Acme"). `masterSearch` matches substrings, so a transposed letter
-- matches nothing at all -- and the person who mistyped has no way to know
-- whether the party is missing or their finger slipped.
--
-- Trigram similarity is the cheapest honest answer: no dictionary to keep, no
-- language assumptions, and it degrades sensibly on the alphanumeric part
-- codes this catalogue is full of.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint

-- GIN over the columns the pickers actually search. Without these the
-- similarity branch is a sequential scan with a function call per row; with
-- them Postgres can use the index for both the substring and the fuzzy half.
CREATE INDEX IF NOT EXISTS parties_name_trgm_idx ON parties USING gin (name gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS stock_items_name_trgm_idx ON stock_items USING gin (name gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS crm_companies_name_trgm_idx ON crm_companies USING gin (name gin_trgm_ops);
