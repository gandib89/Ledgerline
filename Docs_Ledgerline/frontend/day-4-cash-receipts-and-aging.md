# Day 4 Frontend: Cash Receipts and Receivables

## What was built

- A receipt screen where the user chooses a customer, bank account, receipt date, and amount.
- Open invoices load for the chosen customer and the payment can be split across several invoices.
- The screen calculates allocated and unallocated amounts with integer cents, avoiding floating-point money errors.
- The result confirms that the receipt was posted and that its journal entry has equal debits and credits.
- Posted invoice details now show receipt allocation history and the latest outstanding amount.
- AR Aging groups unpaid invoices by overdue period and shows the Accounts Receivable control-account check.
- General Ledger reporting shows opening balance, every movement, running balance, closing balance, and links back to source invoices.
- The existing dashboard continues to show receivables, overdue amounts, revenue, and cash at bank.

## Why this work exists

An invoice only says that a customer owes money. Day 4 completes the cash cycle by recording what the customer actually paid and which invoices that payment settles. The AR control check proves that customer-level outstanding amounts agree with the accounting ledger. The General Ledger drill-down makes every total traceable to its source.

## Main controls

- A payment cannot be zero or negative.
- An allocation cannot exceed either the receipt amount or an invoice's outstanding amount.
- Money calculations use cents rather than JavaScript floating-point arithmetic.
- Receipt posting is hidden from users without `payment.create` permission.
- Successful changes invalidate invoice, reporting, dashboard, and banking caches so the screens reload fresh server values.

## Verification

- Receipt success and over-allocation tests.
- Payment-history rendering test.
- AR Aging control-account and invoice-drill-down test.
- General Ledger opening/running/closing balance test.

