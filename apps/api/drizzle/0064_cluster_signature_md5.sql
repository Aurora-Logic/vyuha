DROP INDEX "duplicate_clusters_org_signature_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "duplicate_clusters_org_signature_md5_uq" ON "duplicate_clusters" USING btree ("org_id",md5("signature"));