/*
  Warnings:

  - Added the required column `requestHash` to the `IdempotencyKey` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "IdempotencyKey" ADD COLUMN     "requestHash" TEXT NOT NULL,
ALTER COLUMN "responseStatus" DROP NOT NULL,
ALTER COLUMN "responseBody" DROP NOT NULL;
