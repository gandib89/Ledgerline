import { add, dec, isZero } from '../money.js';

// One journal line. Only Dr AR / Dr Bank lines carry partyId — everything
// else is GL-only (§6: "The AR and Bank lines carry party_id").
function line({ accountId, debit = 0, credit = 0, description, partyId = null }) {
  return { accountId, debit: dec(debit), credit: dec(credit), description, partyId };
}

// (document) => JournalLine[]. Pure: no I/O, no clock, no randomness — the
// caller resolves every account id (AR control account, each line's tax
// output account) before calling in. That is what makes this trivially
// unit-testable and is the entire point (§6).
//
// Expected `document` shape:
//   { partyId, grandTotal, arAccountId,
//     lines: [{ accountId, taxableAmount, taxAmount, taxAccountId, description }] }
function invoice(document) {
  const lines = [
    line({
      accountId: document.arAccountId,
      debit: document.grandTotal,
      partyId: document.partyId,
      description: 'Accounts Receivable',
    }),
  ];

  for (const docLine of document.lines) {
    lines.push(
      line({
        accountId: docLine.accountId,
        credit: docLine.taxableAmount,
        description: docLine.description,
      })
    );
  }

  // Multiple document lines can share one tax output account (e.g. every
  // 13%-VAT line posts to the same 2200 account) — group so the entry
  // carries one VAT credit per account, not one per invoice line.
  const taxByAccount = new Map();
  for (const docLine of document.lines) {
    if (!docLine.taxAccountId || isZero(docLine.taxAmount)) continue;
    taxByAccount.set(docLine.taxAccountId, add(taxByAccount.get(docLine.taxAccountId) ?? 0, docLine.taxAmount));
  }
  for (const [taxAccountId, taxAmount] of taxByAccount) {
    lines.push(line({ accountId: taxAccountId, credit: taxAmount, description: 'VAT Payable (Output)' }));
  }

  return lines.map((l, i) => ({ ...l, lineNumber: i + 1 }));
}

// User-supplied lines, passed straight through. Control-account blocking
// (PERM-6) and balance are enforced by the caller/guards and by
// postDocument's own assertion — this rule trusts its input, same as every
// other pure rule.
function manual(document) {
  return document.lines.map((docLine, i) => ({
    accountId: docLine.accountId,
    debit: dec(docLine.debit ?? 0),
    credit: dec(docLine.credit ?? 0),
    partyId: docLine.partyId ?? null,
    description: docLine.description,
    lineNumber: i + 1,
  }));
}

// Dr Bank/Cash (amount) / Cr AR (amount, carries partyId) — §6 posting rule
// table. Receipts have no per-line tax; the whole thing is one amount.
//
// Expected shape: { depositAccountId, arAccountId, partyId, amount }
function receipt(document) {
  const lines = [
    line({ accountId: document.depositAccountId, debit: document.amount, description: 'Customer receipt' }),
    line({ accountId: document.arAccountId, credit: document.amount, partyId: document.partyId, description: 'Accounts Receivable' }),
  ];
  return lines.map((l, i) => ({ ...l, lineNumber: i + 1 }));
}

// Mirror image of invoice(): revenue and VAT move to the debit side, AR
// moves to the credit side (§6 posting rule table — "Credit note: Debit
// Sales Revenue (taxable); VAT Payable (tax) / Credit Accounts Receivable").
//
// Expected shape: same as invoice() — { partyId, grandTotal, arAccountId,
// lines: [{ accountId, taxableAmount, taxAmount, taxAccountId, description }] }
function creditNote(document) {
  const lines = [];

  for (const docLine of document.lines) {
    lines.push(line({ accountId: docLine.accountId, debit: docLine.taxableAmount, description: docLine.description }));
  }

  const taxByAccount = new Map();
  for (const docLine of document.lines) {
    if (!docLine.taxAccountId || isZero(docLine.taxAmount)) continue;
    taxByAccount.set(docLine.taxAccountId, add(taxByAccount.get(docLine.taxAccountId) ?? 0, docLine.taxAmount));
  }
  for (const [taxAccountId, taxAmount] of taxByAccount) {
    lines.push(line({ accountId: taxAccountId, debit: taxAmount, description: 'VAT Payable (Output) reversal' }));
  }

  lines.push(
    line({
      accountId: document.arAccountId,
      credit: document.grandTotal,
      partyId: document.partyId,
      description: 'Accounts Receivable',
    })
  );

  return lines.map((l, i) => ({ ...l, lineNumber: i + 1 }));
}

export const POSTING_RULES = { invoice, manual, receipt, creditNote };
