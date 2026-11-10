-- Accounts Payable (spec #2): Bill lines claim input VAT through the tax
-- code's input account. Point every existing organization's VAT13 at that
-- organization's own VAT Receivable (Input) account, 2210. New organizations
-- get this from the starter kit (src/lib/orgs/starter-kit.js).
-- Idempotent, and never overwrites an input account someone already chose.
-- Organizations without a 2210 account are left alone.
UPDATE "TaxCode" tc
SET "inputAccountId" = a."id"
FROM "Account" a
WHERE tc."code" = 'VAT13'
  AND tc."inputAccountId" IS NULL
  AND a."organizationId" = tc."organizationId"
  AND a."code" = '2210';
