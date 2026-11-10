// Due Date arithmetic shared by Invoices and Bills.
export function addDays(date, days) {
  const d = new Date(date);
  // eslint-disable-next-line no-restricted-syntax -- day-of-month arithmetic, not money
  d.setDate(d.getDate() + days);
  return d;
}
