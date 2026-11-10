-- Supplier Reference rules for Bills (raw SQL: Prisma can't express either).
-- Fails if the database already holds duplicate non-reversed Bills for a Supplier;
-- reset or reseed first.

-- A Bill's Supplier Reference must be unique per Supplier, compared trimmed and
-- case-insensitively. Drafts count; reversed Bills don't block a corrected re-entry.
CREATE UNIQUE INDEX "Document_bill_supplier_reference_key"
  ON "Document" ("organizationId", "partyId", lower(btrim("referenceNo")))
  WHERE "docType" = 'BILL' AND "status" <> 'REVERSED';

-- Without this, a NULL referenceNo would never collide and skip the rule above.
ALTER TABLE "Document" ADD CONSTRAINT "Document_bill_reference_required"
  CHECK ("docType" <> 'BILL' OR ("referenceNo" IS NOT NULL AND btrim("referenceNo") <> ''));
