const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
};

export const DEMO_SCENARIO = deepFreeze({
  organizationName: 'Annapurna Trading Pvt. Ltd.',
  actorEmail: 'sunita@annapurnatrading.com.np',
  opening: {
    date: '2025-07-17', reference: 'DEMO-OPENING-2082', amount: '500000.00',
    bankAccountCode: '1020', capitalAccountCode: '3100', narration: 'Demo opening balance',
  },
  invoices: [
    {
      date: '2026-01-12', customerCode: 'CUS-001', reference: 'DEMO-INV-HIMALAYAN', docNo: 'INV-2082-0001',
      description: '15 trekking backpacks @ NPR 8,000', revenueAccountCode: '4100', quantity: '15', unitPrice: '8000.00',
      taxableAmount: '120000.00', vatAmount: '15600.00', total: '135600.00',
    },
    {
      date: '2026-01-25', customerCode: 'CUS-002', reference: 'DEMO-INV-EVEREST', docNo: 'INV-2082-0002',
      description: 'Kitchen equipment installation', revenueAccountCode: '4200', quantity: '1', unitPrice: '45000.00',
      taxableAmount: '45000.00', vatAmount: '5850.00', total: '50850.00',
    },
    {
      date: '2026-02-18', customerCode: 'CUS-003', reference: 'DEMO-INV-SAGARMATHA', docNo: 'INV-2082-0003',
      description: 'Hand tools consignment', revenueAccountCode: '4100', quantity: '1', unitPrice: '30000.00',
      taxableAmount: '30000.00', vatAmount: '3900.00', total: '33900.00',
    },
  ],
  rent: {
    date: '2026-01-20', reference: 'DEMO-RENT-MAGH', amount: '25000.00',
    expenseAccountCode: '5300', bankAccountCode: '1020', narration: 'Office rent, Magh — DEMO-RENT-MAGH',
  },
  receipts: [
    { date: '2026-02-05', customerCode: 'CUS-001', invoiceReference: 'DEMO-INV-HIMALAYAN', reference: 'NEFT8834512', amount: '100000.00' },
    { date: '2026-02-08', customerCode: 'CUS-002', invoiceReference: 'DEMO-INV-EVEREST', reference: 'IPS2210094', amount: '50850.00' },
  ],
  statement: {
    bankName: 'Nabil Bank', accountNoMasked: '****9231', fileName: 'nabil-current-jan-feb-2026.csv',
    openingBalance: '500000.00', closingBalance: '624720.00', serviceCharge: '1130.00',
    csv: [
      'Date,Description,Reference,Debit,Credit,Balance',
      '2026-01-20,RENT PAYMENT ANNAPURNA COMPLEX PVT LTD,CHQ 004821,25000.00,,475000.00',
      '2026-02-05,NEFT/HIMALAYAN TREK SUPPLIES/INV-2082-0001,NEFT8834512,,100000.00,575000.00',
      '2026-02-08,IPS/EVEREST CAFE PVT LTD,IPS2210094,,50850.00,625850.00',
      '2026-02-25,MONTHLY SERVICE CHARGE,,1130.00,,624720.00',
    ].join('\n'),
  },
  expected: {
    receivables: '69500.00', overdue: '35600.00', cash: '624720.00', revenue: '195000.00',
    expenses: '26130.00', netProfit: '168870.00', reconciliationDifference: '0.00',
  },
});

function cents(value) {
  const match = String(value).match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!match) throw new Error(`Invalid demo money value: ${value}`);
  return BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
}

export function validateDemoScenario(scenario) {
  for (const invoice of scenario.invoices) {
    const taxable = cents(invoice.quantity) * cents(invoice.unitPrice) / 100n;
    if (taxable !== cents(invoice.taxableAmount)) throw new Error(`Demo invoice ${invoice.reference} taxable amount is inconsistent`);
    if (taxable * 13n / 100n !== cents(invoice.vatAmount)) throw new Error(`Demo invoice ${invoice.reference} VAT is not 13%`);
    if (taxable + cents(invoice.vatAmount) !== cents(invoice.total)) throw new Error(`Demo invoice ${invoice.reference} total is inconsistent`);
  }

  const statementRows = scenario.statement.csv.split('\n').slice(1).map((row) => row.split(','));
  let balance = cents(scenario.statement.openingBalance);
  for (const row of statementRows) {
    balance -= row[3] ? cents(row[3]) : 0n;
    balance += row[4] ? cents(row[4]) : 0n;
    if (balance !== cents(row[5])) throw new Error(`Demo statement balance is inconsistent on ${row[0]}`);
  }
  if (balance !== cents(scenario.statement.closingBalance)) throw new Error('Demo statement closing balance is inconsistent');

  const outstanding = scenario.invoices.reduce((total, invoice) => total + cents(invoice.total), 0n)
    - scenario.receipts.reduce((total, receipt) => total + cents(receipt.amount), 0n);
  if (outstanding !== cents(scenario.expected.receivables)) throw new Error('Demo receivables total is inconsistent');
  return true;
}

async function accountMap(db, organizationId) {
  const accounts = await db.account.findMany({ where: { organizationId } });
  return new Map(accounts.map((account) => [account.code, account]));
}

async function ensureManualEntry(db, actor, spec, debitAccount, creditAccount, postManualEntry) {
  const existing = await db.journalEntry.findFirst({
    where: { organizationId: actor.organizationId, documentType: 'manual', description: spec.narration },
    include: { lines: true },
  });
  if (existing) return existing;
  return postManualEntry(actor, {
    entryDate: spec.date,
    narration: spec.narration,
    lines: [
      { accountId: debitAccount.id, debit: spec.amount, credit: '0', description: spec.narration },
      { accountId: creditAccount.id, debit: '0', credit: spec.amount, description: spec.narration },
    ],
  });
}

async function loadDocumentWithJournal(db, document) {
  return db.document.findUniqueOrThrow({ where: { id: document.id }, include: { journalEntry: { include: { lines: true } } } });
}

async function ensureInvoice(db, actor, spec, masters, createDraftInvoice, postDocument) {
  let document = await db.document.findFirst({
    where: { organizationId: actor.organizationId, docType: 'INVOICE', referenceNo: spec.reference },
  });
  if (!document) {
    document = await createDraftInvoice(actor, {
      partyId: masters.parties.get(spec.customerCode).id,
      docDate: spec.date,
      referenceNo: spec.reference,
      notes: 'Ledgerline Section 14 demo data',
      lines: [{
        accountId: masters.accounts.get(spec.revenueAccountCode).id,
        description: spec.description,
        quantity: spec.quantity,
        unitPrice: spec.unitPrice,
        discountPct: '0',
        taxCodeId: masters.vat.id,
      }],
    });
  }
  if (document.status === 'DRAFT') await postDocument(document.id, actor);
  const posted = await loadDocumentWithJournal(db, document);
  if (posted.docNo !== spec.docNo) {
    throw new Error(`Expected ${spec.reference} to be ${spec.docNo}, received ${posted.docNo}. Seed a clean demo database.`);
  }
  return posted;
}

async function ensureReceipt(db, actor, spec, masters, invoice, postReceipt) {
  let receipt = await db.document.findFirst({
    where: { organizationId: actor.organizationId, docType: 'RECEIPT', referenceNo: spec.reference },
  });
  if (!receipt) {
    const result = await postReceipt(actor, {
      partyId: masters.parties.get(spec.customerCode).id,
      docDate: spec.date,
      depositAccountId: masters.accounts.get('1020').id,
      amount: spec.amount,
      referenceNo: spec.reference,
      notes: 'Ledgerline Section 14 demo receipt',
      allocations: [{ invoiceId: invoice.id, amount: spec.amount }],
    });
    receipt = result.document;
  }
  return loadDocumentWithJournal(db, receipt);
}

async function seedAuditRecord(db, actor, requestId, entry) {
  const exists = await db.auditLog.findFirst({ where: { organizationId: actor.organizationId, requestId } });
  if (!exists) await db.auditLog.create({ data: { organizationId: actor.organizationId, userId: actor.userId, requestId, ipAddress: '127.0.0.1', ...entry } });
}

export async function seedDemoScenario(db, context) {
  validateDemoScenario(DEMO_SCENARIO);
  const [
    { createDraftInvoice }, { postDocument }, { postManualEntry }, { postReceipt },
    { importStatement }, { manualMatchLine, createEntryFromLine, createReconciliation, completeReconciliation },
  ] = await Promise.all([
    import('../src/lib/invoices/invoice-service.js'),
    import('../src/lib/accounting/post-document.js'),
    import('../src/lib/accounting/post-manual-entry.js'),
    import('../src/lib/accounting/receipt-service.js'),
    import('../src/lib/banking/statement-import-service.js'),
    import('../src/lib/banking/reconciliation-service.js'),
  ]);

  const actor = { userId: context.userId, organizationId: context.organizationId, roleId: context.roleId };
  const accounts = await accountMap(db, actor.organizationId);
  const parties = new Map((await db.party.findMany({ where: { organizationId: actor.organizationId } })).map((party) => [party.code, party]));
  const vat = await db.taxCode.findUniqueOrThrow({ where: { organizationId_code: { organizationId: actor.organizationId, code: 'VAT13' } } });
  const masters = { accounts, parties, vat };

  const opening = await ensureManualEntry(db, actor, DEMO_SCENARIO.opening, accounts.get('1020'), accounts.get('3100'), postManualEntry);
  const firstInvoice = await ensureInvoice(db, actor, DEMO_SCENARIO.invoices[0], masters, createDraftInvoice, postDocument);
  const rent = await ensureManualEntry(db, actor, DEMO_SCENARIO.rent, accounts.get('5300'), accounts.get('1020'), postManualEntry);
  const secondInvoice = await ensureInvoice(db, actor, DEMO_SCENARIO.invoices[1], masters, createDraftInvoice, postDocument);
  const firstReceipt = await ensureReceipt(db, actor, DEMO_SCENARIO.receipts[0], masters, firstInvoice, postReceipt);
  const secondReceipt = await ensureReceipt(db, actor, DEMO_SCENARIO.receipts[1], masters, secondInvoice, postReceipt);
  const thirdInvoice = await ensureInvoice(db, actor, DEMO_SCENARIO.invoices[2], masters, createDraftInvoice, postDocument);

  const bankAccount = await db.bankAccount.upsert({
    where: { organizationId_accountId: { organizationId: actor.organizationId, accountId: accounts.get('1020').id } },
    update: { bankName: DEMO_SCENARIO.statement.bankName, accountNoMasked: DEMO_SCENARIO.statement.accountNoMasked, openingBalance: DEMO_SCENARIO.statement.openingBalance, isActive: true },
    create: { organizationId: actor.organizationId, accountId: accounts.get('1020').id, bankName: DEMO_SCENARIO.statement.bankName, accountNoMasked: DEMO_SCENARIO.statement.accountNoMasked, openingBalance: DEMO_SCENARIO.statement.openingBalance },
  });

  const imported = await importStatement(actor, {
    bankAccountId: bankAccount.id,
    fileName: DEMO_SCENARIO.statement.fileName,
    csvContent: DEMO_SCENARIO.statement.csv,
    columnMapping: { dateFormat: 'YYYY-MM-DD', columns: { date: 'Date', description: 'Description', reference: 'Reference', debit: 'Debit', credit: 'Credit', balance: 'Balance' } },
  });
  const statement = imported.statement;
  let statementLines = await db.bankStatementLine.findMany({ where: { statementId: statement.id }, orderBy: { txnDate: 'asc' } });

  const bankLine = (entry) => entry.lines.find((line) => line.accountId === accounts.get('1020').id);
  const expectedMatches = [bankLine(rent), bankLine(firstReceipt.journalEntry), bankLine(secondReceipt.journalEntry)];
  for (let index = 0; index < 3; index += 1) {
    const line = statementLines[index];
    if (!['MATCHED', 'RECONCILED'].includes(line.status)) await manualMatchLine(actor, line.id, expectedMatches[index].id);
  }

  statementLines = await db.bankStatementLine.findMany({ where: { statementId: statement.id }, orderBy: { txnDate: 'asc' } });
  const serviceChargeLine = statementLines[3];
  if (!['MATCHED', 'RECONCILED'].includes(serviceChargeLine.status)) {
    await createEntryFromLine(actor, serviceChargeLine.id, { accountId: accounts.get('5500').id, narration: 'Nabil monthly service charge' });
  }

  let reconciliation = await db.reconciliation.findFirst({ where: { organizationId: actor.organizationId, statementId: statement.id } });
  if (!reconciliation) reconciliation = await createReconciliation(actor, { bankAccountId: bankAccount.id, statementId: statement.id, asOfDate: '2026-02-25' });
  if (reconciliation.status !== 'COMPLETED') reconciliation = await completeReconciliation(actor, reconciliation.id);

  await seedAuditRecord(db, actor, 'demo-invoice-posted', {
    action: 'invoice.posted', entityType: 'Document', entityId: thirdInvoice.id,
    before: { status: 'DRAFT', docNo: null }, after: { status: 'POSTED', docNo: thirdInvoice.docNo },
  });
  await seedAuditRecord(db, actor, 'demo-reconciliation-completed', {
    action: 'reconciliation.completed', entityType: 'Reconciliation', entityId: reconciliation.id,
    before: { status: 'IN_PROGRESS', difference: DEMO_SCENARIO.statement.serviceCharge },
    after: { status: 'COMPLETED', difference: '0.00', unreconciledCount: 0 },
  });

  return {
    openingEntryId: opening.id,
    invoiceIds: [firstInvoice.id, secondInvoice.id, thirdInvoice.id],
    receiptIds: [firstReceipt.id, secondReceipt.id],
    bankAccountId: bankAccount.id,
    statementId: statement.id,
    reconciliationId: reconciliation.id,
  };
}
