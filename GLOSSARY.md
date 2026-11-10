# Ledgerline

A multi-tenant double-entry accounting platform for Nepali businesses. Business documents go in, and the general ledger is the single source of truth for every balance and report.

## Parties

**Customer**:
A party the organization sells to and raises Invoices against.
_Avoid_: Client, buyer, debtor

**Supplier**:
A party the organization buys from and records Bills against. A party can be both a Customer and a Supplier.
_Avoid_: Vendor, creditor

## Receivables

**Invoice**:
A posted claim on a Customer for goods or services sold, including output VAT.
_Avoid_: Sales bill, sales invoice

**Receipt**:
Money received from a Customer.
_Avoid_: Customer payment, collection

## Payables

**Bill**:
A Supplier's invoice to the organization, recorded as an amount owed, including input VAT.
_Avoid_: Purchase invoice, purchase bill, expense

**Supplier Reference**:
The Supplier's own number printed on their invoice. It identifies a Bill to the outside world and must not repeat for the same Supplier among Bills that haven't been reversed.
_Avoid_: Bill number (that is the organization's own number), vendor ref

**Bill Date**:
The date printed on the Supplier's invoice, not the date it was keyed in. The Due Date counts from it.
_Avoid_: Entry date, invoice date (ambiguous with our own Invoices)

**Posting Date**:
The date a document takes effect in the ledger. It decides the accounting period, fiscal year and numbering series. It is never earlier than the document's own date, and for a Bill it can be later than the Bill Date when the Bill Date's period is already locked.
_Avoid_: Entry date, booking date, recorded date

**Supplier Payment**:
Money paid out to a Supplier.
_Avoid_: Payment (ambiguous next to Receipt), disbursement, payout

## Settlement

**Allocation**:
Applying part or all of a payment document to an open target document: a Receipt to an Invoice, or a Supplier Payment to a Bill. One payment can settle several targets, and one target can be settled by several payments.
_Avoid_: Matching (that is bank reconciliation), application

**Unapplied Amount**:
The part of a Receipt or Supplier Payment not yet allocated to any target: an advance from a Customer or an advance to a Supplier.
_Avoid_: Credit balance, prepayment, on-account

**Aging**:
A party-by-party breakdown of what is still owed, bucketed by how overdue it is. An Aging's total must equal the balance of its Control Account.
_Avoid_: Ageing, outstanding report

**Control Account**:
A ledger account whose balance is the sum of one party sub-ledger: Accounts Receivable for Customers, Accounts Payable for Suppliers.
_Avoid_: Summary account
