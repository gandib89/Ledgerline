import { notFound } from './errors.js';

export async function getInvoicePaymentHistory(tx, organizationId, invoiceId) {
  const invoice = await tx.document.findFirst({
    where: { id: invoiceId, organizationId, docType: 'INVOICE' },
  });
  if (!invoice) throw notFound('Invoice not found');

  const allocations = await tx.paymentAllocation.findMany({
    where: { organizationId, targetDocumentId: invoiceId },
    include: { paymentDocument: true },
    orderBy: { allocatedAt: 'desc' },
  });

  return {
    invoiceId,
    outstandingAmount: invoice.outstandingAmount.toFixed(2),
    payments: allocations.map(({ amount, allocatedAt, paymentDocument }) => ({
      receiptId: paymentDocument.id,
      receiptNo: paymentDocument.docNo,
      docDate: paymentDocument.docDate.toISOString().slice(0, 10),
      referenceNo: paymentDocument.referenceNo,
      amount: amount.toFixed(2),
      allocatedAt: allocatedAt.toISOString(),
    })),
  };
}

// Bill variant of the above: the Supplier Payments applied to a Bill.
export async function getBillPaymentHistory(tx, organizationId, billId) {
  const bill = await tx.document.findFirst({
    where: { id: billId, organizationId, docType: 'BILL' },
  });
  if (!bill) throw notFound('Bill not found');

  const allocations = await tx.paymentAllocation.findMany({
    where: { organizationId, targetDocumentId: billId },
    include: { paymentDocument: true },
    orderBy: { allocatedAt: 'desc' },
  });

  return {
    billId,
    outstandingAmount: bill.outstandingAmount.toFixed(2),
    payments: allocations.map(({ amount, allocatedAt, paymentDocument }) => ({
      supplierPaymentId: paymentDocument.id,
      supplierPaymentNo: paymentDocument.docNo,
      docDate: paymentDocument.docDate.toISOString().slice(0, 10),
      referenceNo: paymentDocument.referenceNo,
      amount: amount.toFixed(2),
      allocatedAt: allocatedAt.toISOString(),
    })),
  };
}
