import { add, dec, isZero } from '../money.js';

function line({ accountId, debit = 0, credit = 0, description, partyId = null }) {
  return { accountId, debit: dec(debit), credit: dec(credit), description, partyId };
}


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


  for (const docLine of document.lines) {
    if (!docLine.taxAccountId || isZero(docLine.taxAmount)) continue;
    taxByAccount.set(docLine.taxAccountId, add(taxByAccount.get(docLine.taxAccountId) ?? 0, docLine.taxAmount));
  }
  for (const [taxAccountId, taxAmount] of taxByAccount) {
    lines.push(line({ accountId: taxAccountId, credit: taxAmount, description: 'VAT Payable (Output)' }));
  }

  return lines.map((l, i) => ({ ...l, lineNumber: i + 1 }));
}


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

function receipt(document) {
  const lines = [
    line({ accountId: document.depositAccountId, debit: document.amount, description: 'Customer receipt' }),
    line({ accountId: document.arAccountId, credit: document.amount, partyId: document.partyId, description: 'Accounts Receivable' }),
  ];
  return lines.map((l, i) => ({ ...l, lineNumber: i + 1 }));
}


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


function bankAdjustment(document) {
  return document.lines.map((docLine, i) => ({
    accountId: docLine.accountId,
    debit: dec(docLine.debit ?? 0),
    credit: dec(docLine.credit ?? 0),
    partyId: null,
    description: docLine.description,
    lineNumber: i + 1,
  }));
}

export const POSTING_RULES = { invoice, manual, receipt, creditNote, bankAdjustment };
