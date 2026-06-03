-- Pass 3 retrieval (TAPROOT_RETRIEVAL_V2): per-file token index storage.
-- Nullable JSONB, mirrors 0026_extracted_cardinality. Populated passively by the
-- writeFile hook + loadIndexData backfill; read back in one SELECT by the V2
-- retrieval path. Harmless under V1 (ignored). Rollback: DROP COLUMN (isolated,
-- nullable, no FKs).
ALTER TABLE vault_files ADD COLUMN extracted_tokens JSONB;
