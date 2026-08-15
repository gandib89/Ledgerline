-- AlterTable
ALTER TABLE "JournalEntry" ADD COLUMN     "reversalOfId" TEXT;

-- CreateTable
CREATE TABLE "PaymentAllocation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "paymentDocumentId" TEXT NOT NULL,
    "targetDocumentId" TEXT NOT NULL,
    "amount" DECIMAL(18,4) NOT NULL,
    "allocatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "PaymentAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentAllocation_organizationId_targetDocumentId_idx" ON "PaymentAllocation"("organizationId", "targetDocumentId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAllocation_paymentDocumentId_targetDocumentId_key" ON "PaymentAllocation"("paymentDocumentId", "targetDocumentId");

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_paymentDocumentId_fkey" FOREIGN KEY ("paymentDocumentId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_targetDocumentId_fkey" FOREIGN KEY ("targetDocumentId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Prisma can't express a CHECK constraint in schema.prisma — hand-written,
-- same convention as the Day 1 balance/sign/immutability triggers.
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_amount_check" CHECK ("amount" > 0);

-- Day 3's block_journal_mutation() was unconditional and is shared, by name,
-- between the JournalEntry and JournalLine triggers. reverseEntry() (Day 4)
-- needs exactly one permitted transition: flipping a POSTED JournalEntry to
-- REVERSED without touching any financial field. JournalLine must stay
-- fully immutable forever — a reversal always inserts a brand new entry and
-- new lines, it never touches the original lines.
--
-- This can't be one shared function with a TG_TABLE_NAME guard: PL/pgSQL
-- compiles a generic trigger function's NEW/OLD field references against
-- the actual row type the FIRST time it runs for that table, even inside a
-- branch that would never be reached at runtime for that table (e.g.
-- referencing NEW."entryNumber" while attached to JournalLine, which has no
-- such column, fails to compile even though TG_OP/TG_TABLE_NAME would have
-- short-circuited it at runtime). So JournalEntry gets its own function.
CREATE OR REPLACE FUNCTION block_journal_entry_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.status = 'POSTED' AND NEW.status = 'REVERSED'
     AND NEW."entryNumber" = OLD."entryNumber"
     AND NEW."entryDate" = OLD."entryDate"
     AND NEW.description IS NOT DISTINCT FROM OLD.description
     AND NEW."documentType" = OLD."documentType"
     AND NEW."sourceId" IS NOT DISTINCT FROM OLD."sourceId"
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Journal entries are immutable. Post a reversal entry instead.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER "journal_entry_immutable" ON "JournalEntry";
CREATE TRIGGER "journal_entry_immutable"
  BEFORE UPDATE OR DELETE ON "JournalEntry"
  FOR EACH ROW
  EXECUTE FUNCTION block_journal_entry_mutation();

-- block_journal_mutation() stays exactly as Day 1 defined it — unconditional
-- — and now belongs only to journal_line_immutable (JournalLine keeps using
-- it unchanged; restated here only so this migration is self-contained).
CREATE OR REPLACE FUNCTION block_journal_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Journal entries are immutable. Post a reversal entry instead.';
END;
$$ LANGUAGE plpgsql;
