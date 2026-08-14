import { prisma } from '../../db/client.js';
import { POSTING_RULES } from './posting-rules.js';
import { nextEntryNumber } from './document-numbering.js';
import { assertPeriodOpen } from './period-lock.js';
import { findFiscalYearForDate } from './fiscal-year.js';
import { businessRule, internal, notFound } from './errors.js';
import { add, eq, dec } from '../money.js';

// Manual JVs have no Document row (§5's documents.doc_type enum excludes
// "manual") and create-and-post in one step — there's no draft workflow for
// a journal a human is typing by hand. Everything else — period lock,
// locked entry_no allocation, balance assertion — mirrors postDocument.
export async function postManualEntry(actor, { entryDate, narration, lines: lineInputs }) {
  return prisma.$transaction(async (tx) => {
    if (!lineInputs || lineInputs.length === 0) {
      throw businessRule('empty_entry', 'A journal entry needs at least one line');
    }

    const date = new Date(entryDate);
    const fiscalYear = await findFiscalYearForDate(tx, actor.organizationId, date);
    const period = await assertPeriodOpen(tx, { organizationId: actor.organizationId, docDate: date });

    const accountIds = [...new Set(lineInputs.map((l) => l.accountId))];
    const accounts = await tx.account.findMany({
      where: { organizationId: actor.organizationId, id: { in: accountIds } },
    });
    const accountById = new Map(accounts.map((a) => [a.id, a]));

    for (const line of lineInputs) {
      const account = accountById.get(line.accountId);
      if (!account) throw notFound(`Account ${line.accountId} not found`);
      // PERM-6: control accounts (AR, VAT Payable, ...) are only ever
      // touched by the document-driven posting rules, never a manual JV.
      if (account.isControlAccount) {
        throw businessRule(
          'manual_entry_not_allowed_on_control_account',
          `Account ${account.code} is a control account and cannot be posted to manually`
        );
      }
    }

    const journalLines = POSTING_RULES.manual({
      lines: lineInputs.map((l) => ({
        accountId: l.accountId,
        debit: l.debit ?? 0,
        credit: l.credit ?? 0,
        description: l.description,
        partyId: l.partyId ?? null,
      })),
    });

    const debits = journalLines.reduce((total, l) => add(total, l.debit), dec(0));
    const credits = journalLines.reduce((total, l) => add(total, l.credit), dec(0));
    if (!eq(debits, credits)) {
      throw internal(`Unbalanced manual entry: debits ${debits} vs credits ${credits}`);
    }

    const yearLabel = fiscalYear.label.split('/')[0];
    const entryNumber = await nextEntryNumber(tx, {
      organizationId: actor.organizationId,
      fiscalYearId: fiscalYear.id,
      yearLabel,
    });

    return tx.journalEntry.create({
      data: {
        organizationId: actor.organizationId,
        periodId: period.id,
        entryNumber,
        documentType: 'manual',
        entryDate: date,
        description: narration,
        status: 'POSTED',
        sourceId: null,
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
      include: { lines: true },
    });
  });
}
