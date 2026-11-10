# Posted ledger records are immutable; corrections are reversals

Once a journal entry is posted, Postgres triggers (`journal_entry_immutable`, `journal_line_immutable`) reject any UPDATE or DELETE, except a single POSTED → REVERSED status flip that leaves the entry's number, date, description, and source untouched. A mistake is corrected by posting a new, opposite reversal entry in an open period, never by editing or deleting the original. We chose this over in-place edits or soft deletes because an accounting ledger must be an append-only audit trail: a figure in a filed VAT return or a reconciled bank statement must still be explainable later, and enforcing it in the database, not just the application, means no code path, script, or future bug can quietly rewrite history.

## Consequences

- Immutability is DB-enforced for the journal (`JournalEntry`, `JournalLine`) only. There is no trigger on `Document`. A posted Document (invoice, bill, receipt, supplier payment) still has fields that are meant to change as payments are applied (`status`, `allocatedAmount`, `outstandingAmount`). Its financial amounts and lines are protected by the service layer, not by a trigger: update paths must reject any document that isn't DRAFT.
- The journal is the source of truth. Financial statements (trial balance, GL, P&L, balance sheet) are derived from journal lines. Aging is the exception: it reads each document's outstanding amount, so it carries a reconciliation check that its total equals its Control Account balance.
- A document with downstream activity can't be reversed directly: a paid invoice needs a credit note, and a paid bill needs its Supplier Payment reversed first.
- Payment allocations are currently hard-deleted on reversal, so aging can only be reported as of today.
