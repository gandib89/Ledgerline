import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../mocks/server.js';
import { createAppQueryClient } from '../query-client.js';
import { PaymentHistory } from './PaymentHistory.jsx';

describe('PaymentHistory', () => {
  it('shows receipt allocations and the current outstanding balance', async () => {
    server.use(http.get('/api/v1/invoices/invoice-1/payments', () => HttpResponse.json({
      invoiceId: 'invoice-1',
      outstandingAmount: '63000.00',
      payments: [{ receiptId: 'receipt-1', receiptNo: 'REC-2082-0001', docDate: '2025-08-20', referenceNo: 'BNK-93', amount: '50000.00', allocatedAt: '2025-08-20T08:00:00.000Z' }],
    })));

    render(<QueryClientProvider client={createAppQueryClient()}><PaymentHistory organizationId="org-1" invoiceId="invoice-1" /></QueryClientProvider>);

    expect(await screen.findByText('REC-2082-0001')).toBeInTheDocument();
    expect(screen.getByText(/50,000\.00/)).toBeInTheDocument();
    expect(screen.getByText(/63,000\.00/)).toBeInTheDocument();
  });
});
