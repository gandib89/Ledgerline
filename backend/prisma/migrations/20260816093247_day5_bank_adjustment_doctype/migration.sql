-- AlterEnum
ALTER TYPE "DocType" ADD VALUE 'BANK_ADJUSTMENT';

-- AlterTable
ALTER TABLE "DocumentLine" ADD COLUMN     "credit" DECIMAL(18,4),
ADD COLUMN     "debit" DECIMAL(18,4);
