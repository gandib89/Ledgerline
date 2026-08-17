import { prisma } from '../../db/client.js';
import { POSTING_RULES } from './posting-rules.js';
import { nextDocNumber, nextEntryNumber } from './document-numbering.js';
import { assertPeriodOpen } from './period-lock.js';
import { notFound, conflict, businessRule, forbidden, internal } from './errors.js';
import { AR_ACCOUNT_CODE } from './chart-of-accounts.js';
import { add, eq, dec } from '../money.js';

// credit_note/receipt/bill/supplier_payment have their own posting rules and
// permission codes on the days that build them (§6 posting rule table) and
// don't route through here — BANK_ADJUSTMENT is the one other type wired
// in, since §7's "create an entry from the line" explicitly posts through
// this same engine.
const DOC_TYPE_RULES = {
  INVOICE: { rulesKey: 'invoice', prefix: 'INV', permission: 'invoice.post', label: 'Sales Invoice' },
  BANK_ADJUSTMENT: { rulesKey: 'bankAdjustment', prefix: 'BADJ', permission: 'bank.reconcile', label: 'Bank Adjustment' },
};

async function assertPermission(tx, actor, permissionCode) {
  const rolePermission = await tx.rolePermission.findFirst({
    where: { roleId: actor.roleId, permission: { code: permissionCode } },
  });
  if (!rolePermission) throw forbidden(`Missing required permission: ${permissionCode}`);
}

// The single entry point. Every financial document goes through this — no
// second code path writes to JournalEntry (§6). actor = { userId,
// organizationId, roleId }. Side effects (audit log, cache bust) are the
// caller's job, run after this resolves — never inside the transaction.
//
// Same optional-tx pattern as postReceipt (§6 receipt-service.js): called
// bare, it opens its own transaction like every invoice post does today.
// Called with an already-open tx — the reconciliation workspace's "create
// entry from line" needs the draft, the post, and the statement-line match
// to commit or roll back together — it joins that transaction instead.
export async function postDocument(documentId, actor, tx = prisma) {
  const run = async (tx) => {
      // 1. Lock the document. Prevents double-posting under concurrent requests.
      const [doc] = await tx.$queryRaw`
      SELECT * FROM "Document"
      WHERE id = ${documentId} AND "organizationId" = ${actor.organizationId}
      FOR UPDATE
    `;
      if (!doc) throw notFound('Document not found');

      // 2. Guards — each throws an error the route handler maps to HTTP.
      if (doc.status !== 'DRAFT') {
        throw conflict('already_posted', `Document ${doc.id} is already ${doc.status.toLowerCase()}`);
      }

      const org = await tx.organization.findUniqueOrThrow({ where: { id: actor.organizationId } });
      if (!org.isActive) throw businessRule('organization_read_only', 'Organization is read-only');

      const period = await assertPeriodOpen(tx, { organizationId: actor.organizationId, docDate: doc.docDate });

      const config = DOC_TYPE_RULES[doc.docType];
      if (!config) throw internal(`No posting rule wired for document type ${doc.docType}`);

      await assertPermission(tx, actor, config.permission);

      // 3. Allocate doc_no and entry_no from their locked series rows.
      const fiscalYear = await tx.fiscalYear.findFirstOrThrow({
        where: { id: doc.fiscalYearId, organizationId: actor.organizationId },
      });
      const yearLabel = fiscalYear.label.split('/')[0];

      const docNo = await nextDocNumber(tx, {
        organizationId: actor.organizationId,
        docType: doc.docType,
        fiscalYearId: doc.fiscalYearId,
        prefix: config.prefix,
        yearLabel,
      });
      const entryNumber = await nextEntryNumber(tx, {
        organizationId: actor.organizationId,
        fiscalYearId: doc.fiscalYearId,
        yearLabel,
      });

      // 4. Build journal lines from the rule set for this document type.
      const docLines = await tx.documentLine.findMany({
        where: { documentId: doc.id },
        include: { taxCode: true },
        orderBy: { lineNo: 'asc' },
      });

      let journalLines;
      if (doc.docType === 'INVOICE') {
        const arAccount = await tx.account.findFirst({
          where: { organizationId: actor.organizationId, code: AR_ACCOUNT_CODE },
        });
        if (!arAccount) throw internal(`Accounts Receivable account (${AR_ACCOUNT_CODE}) not found for this organization`);

        journalLines = POSTING_RULES.invoice({
          partyId: doc.partyId,
          arAccountId: arAccount.id,
          grandTotal: dec(doc.grandTotal),
          lines: docLines.map((l) => ({
            accountId: l.accountId,
            taxableAmount: l.taxableAmount,
            taxAmount: l.taxAmount,
            taxAccountId: l.taxCode?.outputAccountId ?? null,
            description: l.description,
          })),
        });
      } else if (doc.docType === 'BANK_ADJUSTMENT') {
        // No AR line, no party, no tax — a plain debit/credit pair straight
        // off the document lines (§7 resolution path 2).
        journalLines = POSTING_RULES.bankAdjustment({
          lines: docLines.map((l) => ({ accountId: l.accountId, debit: l.debit, credit: l.credit, description: l.description })),
        });
      } else {
        throw internal(`No journal-line builder wired for document type ${doc.docType}`);
      }

      // 5. Assert balance in application code too — fail fast with a good
      //    message rather than a raw Postgres exception at COMMIT.
      const debits = journalLines.reduce((total, l) => add(total, l.debit), dec(0));
      const credits = journalLines.reduce((total, l) => add(total, l.credit), dec(0));
      if (!eq(debits, credits)) {
        throw internal(`Unbalanced entry for document ${doc.id}: debits ${debits} vs credits ${credits}`);
      }

      // 6. Write the entry and its lines. The DEFERRED trigger re-checks at COMMIT.
      const entry = await tx.journalEntry.create({
        data: {
          organizationId: actor.organizationId,
          periodId: period.id,
          entryNumber,
          documentType: config.rulesKey,
          entryDate: doc.docDate,
          description: `${config.label} ${docNo}`,
          status: 'POSTED',
          sourceId: doc.id,
          postedAt: new Date(),
          postedById: actor.userId,
          lines: {
            create: journalLines.map((l) => ({
              organizationId: actor.organizationId,
              accountId: l.accountId,
              partyId: l.partyId,
              debit: l.debit,
              credit: l.credit,
              description: l.description,
              lineNumber: l.lineNumber,
            })),
          },
        },
      });

      // 7. Update the document: status, number, journal link, outstanding.
      await tx.document.update({
        where: { id: doc.id },
        data: {
          status: 'POSTED',
          docNo,
          journalEntryId: entry.id,
          outstandingAmount: doc.grandTotal,
          postedAt: new Date(),
          postedById: actor.userId,
          version: { increment: 1 },
        },
      });

      return entry;
  };

  return tx === prisma ? prisma.$transaction(run, { isolationLevel: 'ReadCommitted' }) : run(tx);
}
