-- Taproot Stage 1 — Extensions
-- pgvector preinstalled now so Stage 2 embeddings worker has zero schema migration cost.

create extension if not exists "uuid-ossp";
create extension if not exists pgcrypto;
create extension if not exists vector;
