-- Posting Date: the date a document takes effect in the ledger. Decides its
-- period, fiscal year and numbering series. Existing documents: = docDate.
-- Deliberately NO column default, so a creator that forgets it fails loudly.
ALTER TABLE "Document" ADD COLUMN "postingDate" DATE;
UPDATE "Document" SET "postingDate" = "docDate";
ALTER TABLE "Document" ALTER COLUMN "postingDate" SET NOT NULL;
