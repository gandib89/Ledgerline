-- pg_trgm powers the matching engine's party-name similarity pass (§7).
-- No schema.prisma equivalent — Prisma has no extension declaration for this.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
