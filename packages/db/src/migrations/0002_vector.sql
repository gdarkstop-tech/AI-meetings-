-- 0002_vector: pgvector is required from Phase 6 (hybrid search).
-- It is created here, in its own migration, so that a database without the
-- extension fails loudly and visibly instead of silently degrading search later.
-- Verified locally on PostgreSQL 16.13 with pgvector 0.6.0.
CREATE EXTENSION IF NOT EXISTS vector;
