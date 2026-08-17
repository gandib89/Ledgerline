import { describe, expect, it, vi } from 'vitest';
import { getInvoicePaymentHistory } from './payment-history.js';

describe('invoice payment history', () => {
  it('returns tenant-owned allocations with decimal strings', async () => {
    const tx = {
      document: { findFirst: vi.fn().mockResolvedValue({ id: 'invoice-1', outstandingAmount: { toFixed: () => '63000.00' } }) },
      paymentAllocation: { findMany: vi.fn().mockResolvedValue([{
        amount: { toFixed: () => '50000.00' },
        allocatedAt: new Date('2025-08-20T08:00:00.000Z'),
        paymentDocument: { id: 'receipt-1', docNo: 'REC-2082-0001', docDate: new Date('2025-08-20'), referenceNo: 'BNK-93' },
      }]) },
    };

    await expect(getInvoicePaymentHistory(tx, 'org-1', 'invoice-1')).resolves.toEqual({
      invoiceId: 'invoice-1',
      outstandingAmount: '63000.00',
      payments: [{ receiptId: 'receipt-1', receiptNo: 'REC-2082-0001', docDate: '2025-08-20', referenceNo: 'BNK-93', amount: '50000.00', allocatedAt: '2025-08-20T08:00:00.000Z' }],
    });
    expect(tx.document.findFirst).toHaveBeenCalledWith({ where: { id: 'invoice-1', organizationId: 'org-1', docType: 'INVOICE' } });
  });
});
