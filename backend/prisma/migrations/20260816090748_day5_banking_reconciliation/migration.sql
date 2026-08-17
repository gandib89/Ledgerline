-- CreateEnum
CREATE TYPE "BankStatementLineStatus" AS ENUM ('UNMATCHED', 'SUGGESTED', 'MATCHED', 'RECONCILED', 'IGNORED');

-- CreateEnum
CREATE TYPE "MatchedBy" AS ENUM ('AUTO', 'MANUAL');

-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED');

-- CreateTable
CREATE TABLE "BankAccount" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "accountNoMasked" TEXT NOT NULL,
    "openingBalance" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "BankAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankStatement" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSha256" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "openingBalance" DECIMAL(18,4) NOT NULL,
    "closingBalance" DECIMAL(18,4) NOT NULL,
    "lineCount" INTEGER NOT NULL,
    "importedById" TEXT,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankStatement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankStatementLine" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "statementId" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "txnDate" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "reference" TEXT,
    "debit" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "credit" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "runningBalance" DECIMAL(18,4),
    "rowHash" TEXT NOT NULL,
    "status" "BankStatementLineStatus" NOT NULL DEFAULT 'UNMATCHED',
    "matchedJournalLineId" TEXT,
    "matchConfidence" DECIMAL(4,3),
    "matchedBy" "MatchedBy",
    "matchedAt" TIMESTAMP(3),
    "ignoreReason" TEXT,

    CONSTRAINT "BankStatementLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Reconciliation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "bankAccountId" TEXT NOT NULL,
    "asOfDate" DATE NOT NULL,
    "statementId" TEXT NOT NULL,
    "bookBalance" DECIMAL(18,4) NOT NULL,
    "bankBalance" DECIMAL(18,4) NOT NULL,
    "difference" DECIMAL(18,4) NOT NULL,
    "unreconciledCount" INTEGER NOT NULL,
    "status" "ReconciliationStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "completedById" TEXT,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Reconciliation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BankAccount_organizationId_accountId_key" ON "BankAccount"("organizationId", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "BankStatement_bankAccountId_fileSha256_key" ON "BankStatement"("bankAccountId", "fileSha256");

-- CreateIndex
CREATE UNIQUE INDEX "BankStatementLine_matchedJournalLineId_key" ON "BankStatementLine"("matchedJournalLineId");

-- CreateIndex
CREATE INDEX "BankStatementLine_organizationId_bankAccountId_status_idx" ON "BankStatementLine"("organizationId", "bankAccountId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BankStatementLine_statementId_rowHash_key" ON "BankStatementLine"("statementId", "rowHash");

-- AddForeignKey
ALTER TABLE "BankAccount" ADD CONSTRAINT "BankAccount_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankAccount" ADD CONSTRAINT "BankAccount_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankStatement" ADD CONSTRAINT "BankStatement_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankStatement" ADD CONSTRAINT "BankStatement_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankStatementLine" ADD CONSTRAINT "BankStatementLine_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankStatementLine" ADD CONSTRAINT "BankStatementLine_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "BankStatement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankStatementLine" ADD CONSTRAINT "BankStatementLine_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankStatementLine" ADD CONSTRAINT "BankStatementLine_matchedJournalLineId_fkey" FOREIGN KEY ("matchedJournalLineId") REFERENCES "JournalLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reconciliation" ADD CONSTRAINT "Reconciliation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reconciliation" ADD CONSTRAINT "Reconciliation_bankAccountId_fkey" FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reconciliation" ADD CONSTRAINT "Reconciliation_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "BankStatement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Prisma can't express a CHECK constraint in schema.prisma — hand-written,
-- same convention as Day 1/4's balance/sign/amount checks.
-- A statement line is a bank debit or a bank credit, never both (§7 bank_statement_lines).
ALTER TABLE "BankStatementLine" ADD CONSTRAINT "BankStatementLine_debit_credit_check" CHECK (NOT ("debit" > 0 AND "credit" > 0));

-- The internal control expressed in DDL (§7): you cannot mark a reconciliation
-- complete while book and bank disagree, even via a direct insert/update.
ALTER TABLE "Reconciliation" ADD CONSTRAINT "Reconciliation_difference_zero_check" CHECK ("status" <> 'COMPLETED' OR "difference" = 0);
