// `new Date().toISOString().slice(0, 10)` converts to UTC before slicing —
// Nepal is UTC+5:45, so for the first 5h45m of every Nepal calendar day
// that reads as "yesterday". Report date-filter defaults need Nepal's
// actual calendar day, matching the backend's own default (nepal-date.js).
const NEPAL_TZ = 'Asia/Kathmandu';
const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: NEPAL_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

export function todayInNepal() {
  return formatter.format(new Date());
}
