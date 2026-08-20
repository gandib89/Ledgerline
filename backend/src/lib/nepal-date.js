// The server's own clock has no reliable relationship to Nepal's calendar
// day (containers/cloud hosts default to UTC), and Nepal is UTC+5:45 — so
// plain `new Date().toISOString().slice(0, 10)` reads as "yesterday" for
// roughly the first 5h45m of every Nepal day. Every report's "as of today"
// default needs the actual Nepal calendar day instead.
const NEPAL_TZ = 'Asia/Kathmandu';
const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: NEPAL_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

export function todayInNepal() {
  return formatter.format(new Date());
}
