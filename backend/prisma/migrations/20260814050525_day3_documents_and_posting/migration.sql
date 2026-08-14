/*
  Warnings:

  - Added the required column `organizationId` to the `JournalLine` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "DocType" AS ENUM ('INVOICE', 'CREDIT_NOTE', 'RECEIPT', 'BILL', 'SUPPLIER_PAYMENT');

-- CreateEnum
CREATE TYPE "DocStatus" AS ENUM ('DRAFT', 'POSTED', 'PARTIALLY_PAID', 'PAID', 'REVERSED');

-- CreateEnum
CREATE TYPE "EntryStatus" AS ENUM ('DRAFT', 'POSTED', 'REVERSED');

-- DropIndex
DROP INDEX "JournalEntry_organizationId_entryDate_idx";

-- DropIndex
DROP INDEX "JournalLine_accountId_idx";

-- AlterTable
ALTER TABLE "JournalEntry" ADD COLUMN     "postedAt" TIMESTAMP(3),
ADD COLUMN     "postedById" TEXT,
ADD COLUMN     "sourceId" TEXT,
ADD COLUMN     "status" "EntryStatus" NOT NULL DEFAULT 'DRAFT';

-- AlterTable
ALTER TABLE "JournalLine" ADD COLUMN     "organizationId" TEXT,
ADD COLUMN     "partyId" TEXT;

-- Backfill from the parent entry before enforcing NOT NULL below.
UPDATE "JournalLine" jl
SET "organizationId" = je."organizationId"
FROM "JournalEntry" je
WHERE je.id = jl."journalEntryId";

ALTER TABLE "JournalLine" ALTER COLUMN "organizationId" SET NOT NULL;

-- CreateTable
CREATE TABLE "DocumentSeries" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "docType" "DocType" NOT NULL,
    "fiscalYearId" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "padding" INTEGER NOT NULL DEFAULT 4,
    "nextNumber" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "DocumentSeries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "fiscalYearId" TEXT NOT NULL,
    "docType" "DocType" NOT NULL,
    "docNo" TEXT,
    "docDate" DATE NOT NULL,
    "dueDate" DATE,
    "partyId" TEXT,
    "subtotal" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "discountAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "taxableAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "grandTotal" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "allocatedAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "outstandingAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "status" "DocStatus" NOT NULL DEFAULT 'DRAFT',
    "parentDocumentId" TEXT,
    "referenceNo" TEXT,
    "notes" TEXT,
    "journalEntryId" TEXT,
    "postedAt" TIMESTAMP(3),
    "postedById" TEXT,
    "createdById" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentLine" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "quantity" DECIMAL(18,6) NOT NULL,
    "unitPrice" DECIMAL(18,4) NOT NULL,
    "discountPct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "taxableAmount" DECIMAL(18,4) NOT NULL,
    "taxCodeId" TEXT,
    "taxAmount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "lineTotal" DECIMAL(18,4) NOT NULL,

    CONSTRAINT "DocumentLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DocumentSeries_organizationId_docType_fiscalYearId_key" ON "DocumentSeries"("organizationId", "docType", "fiscalYearId");

-- CreateIndex
CREATE UNIQUE INDEX "Document_journalEntryId_key" ON "Document"("journalEntryId");

-- CreateIndex
CREATE INDEX "Document_organizationId_docType_docDate_idx" ON "Document"("organizationId", "docType", "docDate");

-- CreateIndex
CREATE INDEX "Document_organizationId_partyId_idx" ON "Document"("organizationId", "partyId");

-- CreateIndex
CREATE UNIQUE INDEX "Document_organizationId_docType_fiscalYearId_docNo_key" ON "Document"("organizationId", "docType", "fiscalYearId", "docNo");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentLine_documentId_lineNo_key" ON "DocumentLine"("documentId", "lineNo");

-- CreateIndex
CREATE INDEX "JournalEntry_organizationId_entryDate_status_idx" ON "JournalEntry"("organizationId", "entryDate", "status");

-- CreateIndex
CREATE INDEX "JournalLine_organizationId_accountId_idx" ON "JournalLine"("organizationId", "accountId");

-- CreateIndex
CREATE INDEX "JournalLine_organizationId_partyId_idx" ON "JournalLine"("organizationId", "partyId");

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentSeries" ADD CONSTRAINT "DocumentSeries_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentSeries" ADD CONSTRAINT "DocumentSeries_fiscalYearId_fkey" FOREIGN KEY ("fiscalYearId") REFERENCES "FiscalYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_fiscalYearId_fkey" FOREIGN KEY ("fiscalYearId") REFERENCES "FiscalYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "Party"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_parentDocumentId_fkey" FOREIGN KEY ("parentDocumentId") REFERENCES "Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentLine" ADD CONSTRAINT "DocumentLine_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentLine" ADD CONSTRAINT "DocumentLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentLine" ADD CONSTRAINT "DocumentLine_taxCodeId_fkey" FOREIGN KEY ("taxCodeId") REFERENCES "TaxCode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CheckConstraint: negatives are expressed as credit notes, not sign flips (§5).
ALTER TABLE "Document" ADD CONSTRAINT "doc_grand_total_nonneg"
  CHECK ("grandTotal" >= 0);

-- CheckConstraint: the seatbelt against over-allocation, independent of the service layer (§5, §6).
ALTER TABLE "Document" ADD CONSTRAINT "doc_outstanding_range"
  CHECK ("outstandingAmount" >= 0 AND "outstandingAmount" <= "grandTotal");

-- CheckConstraint
ALTER TABLE "DocumentLine" ADD CONSTRAINT "docline_qty_price"
  CHECK ("quantity" > 0 AND "unitPrice" >= 0);

-- Partial index: the AR aging report's hot path (§5).
CREATE INDEX "doc_open_by_party" ON "Document" ("organizationId", "partyId")
  WHERE "outstandingAmount" > 0;
