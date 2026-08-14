import { prisma } from '../../db/client.js';
import { computeLine, sumLines } from '../accounting/line-math.js';
import { findFiscalYearForDate } from '../accounting/fiscal-year.js';
import { notFound, conflict, businessRule } from '../accounting/errors.js';
import { dec } from '../money.js';

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

// DocumentLine has no discountAmount column — only discountPct is stored per
// line (§5); discountAmount only exists as a computed value for sumLines'
// document-level aggregation. Strip it before writing a line row.
function toDocumentLineData({ discountAmount: _discountAmount, ...line }) {
  return line;
}

// Totals are never accepted from the client — only quantity/rate/discount/tax
// code come in; taxableAmount, taxAmount, lineTotal are recomputed here from
// scratch every time, draft create or draft update alike (§6 validation layers).
async function resolveLines(tx, organizationId, lineInputs) {
  if (!lineInputs || lineInputs.length === 0) {
    throw businessRule('empty_invoice', 'An invoice needs at least one line');
  }

  const accountIds = [...new Set(lineInputs.map((l) => l.accountId))];
  const taxCodeIds = [...new Set(lineInputs.filter((l) => l.taxCodeId).map((l) => l.taxCodeId))];

  const [accounts, taxCodes] = await Promise.all([
    tx.account.findMany({ where: { organizationId, id: { in: accountIds } } }),
    taxCodeIds.length ? tx.taxCode.findMany({ where: { organizationId, id: { in: taxCodeIds } } }) : [],
  ]);
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const taxCodeById = new Map(taxCodes.map((t) => [t.id, t]));

  for (const line of lineInputs) {
    // A valid UUID from another organisation must fail as 404, not 403 —
    // revealing existence is itself a leak (§6 validation layers).
    if (!accountById.has(line.accountId)) throw notFound(`Account ${line.accountId} not found`);
    if (line.taxCodeId && !taxCodeById.has(line.taxCodeId)) throw notFound(`Tax code ${line.taxCodeId} not found`);
  }

  return lineInputs.map((input, i) => {
    const taxCode = input.taxCodeId ? taxCodeById.get(input.taxCodeId) : null;
    const computed = computeLine({
      quantity: input.quantity,
      unitPrice: input.unitPrice,
      discountPct: input.discountPct ?? 0,
      taxRate: taxCode?.rate ?? 0,
    });

    return {
      lineNo: i + 1,
      description: input.description,
      accountId: input.accountId,
      quantity: dec(input.quantity),
      unitPrice: dec(input.unitPrice),
      discountPct: dec(input.discountPct ?? 0),
      taxCodeId: input.taxCodeId ?? null,
      ...computed,
    };
  });
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
