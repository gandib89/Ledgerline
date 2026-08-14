import { businessRule } from './errors.js';

export async function findFiscalYearForDate(tx, organizationId, date) {
  const fiscalYear = await tx.fiscalYear.findFirst({
    where: { organizationId, startDate: { lte: date }, endDate: { gte: date } },
  });
  if (!fiscalYear) {
    throw businessRule('no_fiscal_year', `No fiscal year covers ${date.toISOString().slice(0, 10)}`);
  }
  return fiscalYear;
}
