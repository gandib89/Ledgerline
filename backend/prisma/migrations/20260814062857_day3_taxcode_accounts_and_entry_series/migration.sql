-- CreateEnum
CREATE TYPE "TaxCodeType" AS ENUM ('VAT', 'EXEMPT', 'ZERO');

-- AlterTable
ALTER TABLE "TaxCode" ADD COLUMN     "inputAccountId" TEXT,
ADD COLUMN     "outputAccountId" TEXT,
ADD COLUMN     "type" "TaxCodeType" NOT NULL DEFAULT 'VAT';

-- CreateTable
CREATE TABLE "EntrySeries" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "fiscalYearId" TEXT NOT NULL,
    "prefix" TEXT NOT NULL DEFAULT 'JE',
    "padding" INTEGER NOT NULL DEFAULT 4,
    "nextNumber" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "EntrySeries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EntrySeries_organizationId_fiscalYearId_key" ON "EntrySeries"("organizationId", "fiscalYearId");

-- AddForeignKey
ALTER TABLE "TaxCode" ADD CONSTRAINT "TaxCode_outputAccountId_fkey" FOREIGN KEY ("outputAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxCode" ADD CONSTRAINT "TaxCode_inputAccountId_fkey" FOREIGN KEY ("inputAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntrySeries" ADD CONSTRAINT "EntrySeries_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntrySeries" ADD CONSTRAINT "EntrySeries_fiscalYearId_fkey" FOREIGN KEY ("fiscalYearId") REFERENCES "FiscalYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
