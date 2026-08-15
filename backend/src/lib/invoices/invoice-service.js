import { prisma } from '../../db/client.js';
import { sumLines } from '../accounting/line-math.js';
import { resolveLines, toDocumentLineData } from '../accounting/document-lines.js';
import { findFiscalYearForDate } from '../accounting/fiscal-year.js';
import { notFound, conflict } from '../accounting/errors.js';

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

// Live totals for the invoice editor — same recomputation as create/update,
// nothing persisted. Backs POST /invoices/preview.
export async function previewInvoice(actor, { lines: lineInputs }) {
  const lines = await resolveLines(prisma, actor.organizationId, lineInputs);
  return { lines, totals: sumLines(lines) };
}

export async function createDraftInvoice(actor, input) {
  return prisma.$transaction(async (tx) => {
    const party = await tx.party.findFirst({ where: { id: input.partyId, organizationId: actor.organizationId } });
    if (!party) throw notFound('Party not found');

    const docDate = new Date(input.docDate);
    const fiscalYear = await findFiscalYearForDate(tx, actor.organizationId, docDate);
    const dueDate = input.dueDate ? new Date(input.dueDate) : addDays(docDate, party.creditDays);

    const lines = await resolveLines(tx, actor.organizationId, input.lines);
    const totals = sumLines(lines);

    return tx.document.create({
      data: {
        organizationId: actor.organizationId,
        fiscalYearId: fiscalYear.id,
        docType: 'INVOICE',
        docDate,
        dueDate,
        partyId: party.id,
        referenceNo: input.referenceNo ?? null,
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
    });
  });
}

// UPDATE ... WHERE id = ? AND version = ?, 0 rows affected -> 409 conflict.
// Drafts only — posted invoices are immutable and go through a credit note
// instead (§6 posting states).
export async function updateDraftInvoice(actor, documentId, expectedVersion, input) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.document.findFirst({
      where: { id: documentId, organizationId: actor.organizationId },
    });
    if (!existing) throw notFound('Invoice not found');
    if (existing.status !== 'DRAFT') throw conflict('not_draft', `Invoice ${documentId} is not a draft`);

    // Always load the real party — its creditDays drives the due date, so
    // assuming a default here would silently write the wrong one.
    const partyId = input.partyId ?? existing.partyId;
    const party = await tx.party.findFirst({ where: { id: partyId, organizationId: actor.organizationId } });
    if (!party) throw notFound('Party not found');

    const docDate = input.docDate ? new Date(input.docDate) : existing.docDate;
    const fiscalYear = await findFiscalYearForDate(tx, actor.organizationId, docDate);

    // An explicit dueDate always wins. Otherwise recompute only when one of
    // its two inputs actually changed — so an unrelated edit never silently
    // overwrites a due date the user set by hand earlier.
    const dueDateChanged = input.docDate || (input.partyId && input.partyId !== existing.partyId);
    const dueDate = input.dueDate
      ? new Date(input.dueDate)
      : dueDateChanged
        ? addDays(docDate, party.creditDays)
        : existing.dueDate;

    const lines = await resolveLines(tx, actor.organizationId, input.lines);
    const totals = sumLines(lines);

    const result = await tx.document.updateMany({
      where: { id: documentId, organizationId: actor.organizationId, version: expectedVersion, status: 'DRAFT' },
      data: {
        fiscalYearId: fiscalYear.id,
        docDate,
        dueDate,
        partyId: party.id,
        referenceNo: input.referenceNo ?? existing.referenceNo,
        notes: input.notes ?? existing.notes,
        subtotal: totals.subtotal,
        discountAmount: totals.discountAmount,
        taxableAmount: totals.taxableAmount,
        taxAmount: totals.taxAmount,
        grandTotal: totals.grandTotal,
        version: { increment: 1 },
      },
    });

    if (result.count === 0) {
      throw conflict('version_conflict', `Invoice ${documentId} was modified by someone else — reload and try again`);
    }

    // Lines are replaced wholesale rather than diffed — simpler, and every
    // draft edit already recomputes every line from scratch anyway.
    await tx.documentLine.deleteMany({ where: { documentId } });
    await tx.documentLine.createMany({ data: lines.map((l) => ({ ...toDocumentLineData(l), documentId })) });

    return tx.document.findUniqueOrThrow({ where: { id: documentId }, include: { lines: true } });
  });
}
