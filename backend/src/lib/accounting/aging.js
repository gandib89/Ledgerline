import { prisma } from '../../db/client.js';
import { dec, add, sub } from '../money.js';

export const AGING_BUCKETS = [
  { key: 'current', label: 'Current', min: -Infinity, max: 0 },
  { key: 'd1_30', label: '1-30 days', min: 1, max: 30 },
  { key: 'd31_60', label: '31-60 days', min: 31, max: 60 },
  { key: 'd61_90', label: '61-90 days', min: 61, max: 90 },
  { key: 'd90_plus', label: '90+ days', min: 91, max: Infinity },
];

function bucketFor(daysOverdue) {
  return AGING_BUCKETS.find((b) => daysOverdue >= b.min && daysOverdue <= b.max).key;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Shared by AR and AP aging. `open` are the party's open documents
// (Invoices / Bills) and `unapplied` the payment documents' Unapplied
// Amounts (Receipts / Supplier Payments); the latter reduce what is owed,
// so they enter the row total (and the grand total) as negatives and are
// what lets the total reconcile to the Control Account.
// open:    [{ partyId, partyName, id, docNo, dueDate: Date, outstanding }]
// unapplied: [{ partyId, partyName, amount }]
export function buildAging({ open, unapplied, today }) {
  const todayDate = new Date(today);
  const byParty = new Map();
  const rowFor = (partyId, partyName) => {
    if (!byParty.has(partyId)) {
      byParty.set(partyId, {
        partyId, partyName,
        buckets: Object.fromEntries(AGING_BUCKETS.map((b) => [b.key, dec(0)])),
        unapplied: dec(0), total: dec(0), invoices: [],
      });
    }
    return byParty.get(partyId);
  };

  for (const d of open) {
    const bucket = bucketFor(Math.floor((todayDate - d.dueDate) / DAY_MS));
    const row = rowFor(d.partyId, d.partyName);
    row.buckets[bucket] = add(row.buckets[bucket], d.outstanding);
    row.total = add(row.total, d.outstanding);
    row.invoices.push({ id: d.id, docNo: d.docNo, dueDate: d.dueDate.toISOString().slice(0, 10), outstandingAmount: dec(d.outstanding).toFixed(2), bucket });
  }
  for (const u of unapplied) {
    const row = rowFor(u.partyId, u.partyName);
    row.unapplied = sub(row.unapplied, u.amount);
    row.total = sub(row.total, u.amount);
  }

  let grandTotal = dec(0);
  const rows = [...byParty.values()].map((row) => {
    grandTotal = add(grandTotal, row.total);
    return {
      partyId: row.partyId,
      partyName: row.partyName,
      buckets: Object.fromEntries(Object.entries(row.buckets).map(([k, v]) => [k, v.toFixed(2)])),
      unapplied: row.unapplied.toFixed(2),
      total: row.total.toFixed(2),
      invoices: row.invoices,
    };
  });
  return { buckets: AGING_BUCKETS.map((b) => ({ key: b.key, label: b.label })), rows, grandTotal };
}

const sumBy = (rows, key) => {
  const sums = new Map();
  for (const r of rows) sums.set(r[key], add(sums.get(r[key]) ?? 0, r.amount));
  return sums;
};

// Loads the as-of-today inputs for buildAging: documents of `openType`
// (INVOICE / BILL) and `paymentType` (RECEIPT / SUPPLIER_PAYMENT) with
// Posting Date <= today. Allocations that cross today are the reconciliation
// hole: an allocation from a payment dated after today lowers the open
// document's outstanding amount although the ledger does not yet see that
// payment, so it is added back (and the payment, itself excluded, never shows
// as Unapplied); an allocation from a payment dated today or earlier to a
// document dated after today lowers the payment's outstanding amount although
// the ledger does not yet see that document, so it is added back to Unapplied.
export async function loadAgingInputs({ organizationId, today, openType, paymentType }) {
  const lte = new Date(today);
  const allocations = (paymentPosting, targetPosting) => prisma.paymentAllocation.findMany({
    where: {
      organizationId,
      paymentDocument: { organizationId, docType: paymentType, postingDate: paymentPosting },
      targetDocument: { organizationId, docType: openType, postingDate: targetPosting },
    },
    select: { paymentDocumentId: true, targetDocumentId: true, amount: true },
  });
  const [paidLater, billedLater] = await Promise.all([allocations({ gt: lte }, { lte }), allocations({ lte }, { gt: lte })]);
  const openAddBack = sumBy(paidLater, 'targetDocumentId');
  const paymentAddBack = sumBy(billedLater, 'paymentDocumentId');

  const documents = (docType, addBack) => prisma.document.findMany({
    where: {
      organizationId, docType, postingDate: { lte }, status: { in: ['POSTED', 'PARTIALLY_PAID', 'PAID'] },
      OR: [{ outstandingAmount: { gt: 0 } }, { id: { in: [...addBack.keys()] } }],
    },
    include: { party: true },
  });
  const [opens, payments] = await Promise.all([documents(openType, openAddBack), documents(paymentType, paymentAddBack)]);

  return {
    open: opens.map((d) => ({
      partyId: d.partyId, partyName: d.party?.name ?? null, id: d.id, docNo: d.docNo, dueDate: d.dueDate ?? d.docDate,
      outstanding: add(d.outstandingAmount, openAddBack.get(d.id) ?? 0),
    })).filter((d) => d.outstanding.gt(0)),
    unapplied: payments.map((d) => ({ partyId: d.partyId, partyName: d.party?.name ?? null, amount: add(d.outstandingAmount, paymentAddBack.get(d.id) ?? 0) })).filter((u) => u.amount.gt(0)),
  };
}
