import { businessRule, notFound } from '../accounting/errors.js';

export async function rejectSuggestedLine(db, organizationId, statementLineId) {
  const line = await db.bankStatementLine.findFirst({
    where: { id: statementLineId, organizationId },
  });
  if (!line) throw notFound('Statement line not found');
  if (line.status !== 'SUGGESTED') {
    throw businessRule('line_not_suggested', 'Only a suggested match can be rejected');
  }

  return db.bankStatementLine.update({
    where: { id: line.id, organizationId, status: 'SUGGESTED' },
    data: {
      status: 'UNMATCHED',
      matchedJournalLineId: null,
      matchConfidence: null,
      matchedBy: null,
      matchedAt: null,
    },
  });
}
