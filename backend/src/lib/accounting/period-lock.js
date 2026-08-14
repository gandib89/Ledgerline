import { businessRule } from './errors.js';

// Service-layer check first (for the nice error message), DB trigger second
// (because the service layer can be bypassed). Belt and braces (§6).
export async function assertPeriodOpen(tx, { organizationId, docDate }) {
  // AccountingPeriod has no organizationId column — scope through its parent
  // fiscal year instead, same as GET /periods (masters.js).
  const period = await tx.accountingPeriod.findFirst({
    where: {
      fiscalYear: { organizationId },
      startDate: { lte: docDate },
      endDate: { gte: docDate },
    },
  });

  const dateStr = docDate.toISOString().slice(0, 10);
  if (!period) throw businessRule('no_period', `No accounting period covers ${dateStr}`);
  if (!period.isOpen) throw businessRule('period_locked', `Accounting period containing ${dateStr} is locked`);

  return period;
}
