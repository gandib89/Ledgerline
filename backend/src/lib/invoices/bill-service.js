import { prisma } from '../../db/client.js';
import { sumLines } from '../accounting/line-math.js';
import { resolveLines, toDocumentLineData } from '../accounting/document-lines.js';
import { findFiscalYearForDate } from '../accounting/fiscal-year.js';
import { notFound, conflict, businessRule } from '../accounting/errors.js';
import { addDays } from './add-days.js';

// Bill lines may only hit EXPENSE or ASSET accounts that are neither control
// nor bank accounts: a purchase must never post straight to AP, VAT or cash.
function checkBillLineAccount(account) {
  const allowedType = account.type === 'EXPENSE' || account.type === 'ASSET';
  if (!allowedType || account.isControlAccount || account.isBankAccount) {
    throw businessRule(
      'bill_line_account_not_allowed',
      `Account ${account.code} cannot be used on a Bill line — only expense or asset accounts that are not control or bank accounts`,
    );
  }
}

async function loadSupplier(tx, organizationId, partyId) {
  const party = await tx.party.findFirst({ where: { id: partyId, organizationId } });
  if (!party) throw notFound('Party not found');
  if (party.type !== 'SUPPLIER' && party.type !== 'BOTH') {
    throw businessRule('party_not_supplier', `${party.name} is not a Supplier — Bills can only be raised against a Supplier`);
  }
  return party;
}

function requireSupplierReference(referenceNo) {
  if (!referenceNo || !referenceNo.trim()) {
    throw businessRule('supplier_reference_required', 'Supplier Reference is required');
  }
}

// Posting Date may not precede the Bill Date, and decides the fiscal year.
async function fiscalYearForPostingDate(tx, organizationId, billDate, postingDate) {
  if (postingDate.getTime() < billDate.getTime()) {
    throw businessRule('posting_date_before_bill_date', 'Posting Date cannot be earlier than the Bill Date');
  }
  return findFiscalYearForDate(tx, organizationId, postingDate);
}

const REFERENCE_INDEX = 'Document_bill_supplier_reference_key';

// Matched by index name only: any other unique violation must still surface.
function isReferenceIndexViolation(err) {
  return err.code === 'P2002' && JSON.stringify([err.meta, err.message]).includes(REFERENCE_INDEX);
}

// Another non-reversed Bill of this Supplier with the same trimmed, case-insensitive
// Supplier Reference (mirrors the partial unique index).
async function findDuplicateBill(tx, organizationId, partyId, referenceNo, excludeId) {
  const [dup] = await tx.$queryRaw`
    SELECT id, "referenceNo" FROM "Document"
    WHERE "organizationId" = ${organizationId} AND "docType" = 'BILL' AND "status" <> 'REVERSED'
      AND "partyId" = ${partyId} AND lower(btrim("referenceNo")) = lower(btrim(${referenceNo}))
      AND id <> ${excludeId ?? ''}
    LIMIT 1`;
  return dup ?? null;
}

function duplicateReference(dup) {
  return conflict(
    'duplicate_supplier_reference',
    `A Bill with Supplier Reference "${dup.referenceNo}" already exists for this Supplier. Open and edit it instead of entering it again.`,
    { billId: dup.id, referenceNo: dup.referenceNo },
  );
}

// Check first for a friendly 409; the SAVEPOINT + named-index catch is the race
// backstop (same pattern as runIdempotent): a lost race aborts the Postgres
// transaction, so roll back to the savepoint before looking up the winner.
async function writeUniqueReference(tx, { organizationId, partyId, referenceNo, excludeId }, write) {
  const dup = await findDuplicateBill(tx, organizationId, partyId, referenceNo, excludeId);
  if (dup) throw duplicateReference(dup);

  await tx.$executeRaw`SAVEPOINT bill_reference_write`;
  try {
    return await write();
  } catch (err) {
    if (!isReferenceIndexViolation(err)) throw err;
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT bill_reference_write`;
    const winner = await findDuplicateBill(tx, organizationId, partyId, referenceNo, excludeId);
    if (!winner) throw err;
    throw duplicateReference(winner);
  }
}

// Live totals for the bill editor — same recomputation as create/update,
// nothing persisted. Backs POST /bills/preview.
export async function previewBill(actor, { lines: lineInputs }) {
  const lines = await resolveLines(prisma, actor.organizationId, lineInputs, { checkAccount: checkBillLineAccount });
  return { lines, totals: sumLines(lines) };
}

export async function createDraftBill(actor, input) {
  return prisma.$transaction(async (tx) => {
    requireSupplierReference(input.referenceNo);
    const party = await loadSupplier(tx, actor.organizationId, input.partyId);

    const billDate = new Date(input.docDate);
    const postingDate = input.postingDate ? new Date(input.postingDate) : billDate;
    const fiscalYear = await fiscalYearForPostingDate(tx, actor.organizationId, billDate, postingDate);
    const dueDate = input.dueDate ? new Date(input.dueDate) : addDays(billDate, party.creditDays);

    const lines = await resolveLines(tx, actor.organizationId, input.lines, { checkAccount: checkBillLineAccount });
    const totals = sumLines(lines);

    return writeUniqueReference(tx, { organizationId: actor.organizationId, partyId: party.id, referenceNo: input.referenceNo }, () => tx.document.create({
      data: {
        organizationId: actor.organizationId,
        fiscalYearId: fiscalYear.id,
        docType: 'BILL',
        docDate: billDate,
        postingDate,
        dueDate,
        partyId: party.id,
        referenceNo: input.referenceNo,
        notes: input.notes ?? null,
        status: 'DRAFT',
        createdById: actor.userId,
        subtotal: totals.subtotal,
        discountAmount: totals.discountAmount,
        taxableAmount: totals.taxableAmount,
        taxAmount: totals.taxAmount,
        grandTotal: totals.grandTotal,
        lines: { create: lines.map(toDocumentLineData) },
      },
      include: { lines: true },
    }));
  });
}

// Drafts only; mirrors updateDraftInvoice (version check, lines replaced wholesale).
export async function updateDraftBill(actor, documentId, expectedVersion, input) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.document.findFirst({
      where: { id: documentId, organizationId: actor.organizationId, docType: 'BILL' },
    });
    if (!existing) throw notFound('Bill not found');
    if (existing.status !== 'DRAFT') throw conflict('not_draft', `Bill ${documentId} is not a draft`);

    const party = await loadSupplier(tx, actor.organizationId, input.partyId ?? existing.partyId);

    const referenceNo = input.referenceNo ?? existing.referenceNo;
    requireSupplierReference(referenceNo);

    const billDate = input.docDate ? new Date(input.docDate) : existing.docDate;
    // A Posting Date that was only ever the default follows the Bill Date; one
    // the user chose stays put (and is re-checked against the Bill Date).
    const postingDate = input.postingDate
      ? new Date(input.postingDate)
      : existing.postingDate.getTime() === existing.docDate.getTime()
        ? billDate
        : existing.postingDate;
    const fiscalYear = await fiscalYearForPostingDate(tx, actor.organizationId, billDate, postingDate);

    // An explicit dueDate always wins; otherwise recompute only when one of
    // its inputs (Bill Date, Supplier) changed. Posting Date never moves it.
    const dueDateChanged = input.docDate || (input.partyId && input.partyId !== existing.partyId);
    const dueDate = input.dueDate
      ? new Date(input.dueDate)
      : dueDateChanged
        ? addDays(billDate, party.creditDays)
        : existing.dueDate;

    const lines = await resolveLines(tx, actor.organizationId, input.lines, { checkAccount: checkBillLineAccount });
    const totals = sumLines(lines);

    const result = await writeUniqueReference(tx, { organizationId: actor.organizationId, partyId: party.id, referenceNo, excludeId: documentId }, () => tx.document.updateMany({
      where: { id: documentId, organizationId: actor.organizationId, version: expectedVersion, status: 'DRAFT' },
      data: {
        fiscalYearId: fiscalYear.id,
        docDate: billDate,
        postingDate,
        dueDate,
        partyId: party.id,
        referenceNo,
        notes: input.notes ?? existing.notes,
        subtotal: totals.subtotal,
        discountAmount: totals.discountAmount,
        taxableAmount: totals.taxableAmount,
        taxAmount: totals.taxAmount,
        grandTotal: totals.grandTotal,
        version: { increment: 1 },
      },
    }));
    if (result.count === 0) {
      throw conflict('version_conflict', `Bill ${documentId} was modified by someone else — reload and try again`);
    }

    await tx.documentLine.deleteMany({ where: { documentId, document: { organizationId: actor.organizationId } } });
    await tx.documentLine.createMany({ data: lines.map((l) => ({ ...toDocumentLineData(l), documentId })) });

    return tx.document.findFirstOrThrow({
      where: { id: documentId, organizationId: actor.organizationId },
      include: { lines: true },
    });
  });
}
