import { apiRequest } from './api-client.js';

const PAGE_SIZE = 20; // matches the backend list endpoints
const MAX_PAGES = 500; // runaway guard, not a business limit

// Loads every page of a paged list endpoint (`path` may already carry a query
// string): stops at the first page shorter than a full page.
export async function fetchAllPages(path) {
  const separator = path.includes('?') ? '&' : '?';
  const rows = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = await apiRequest(`${path}${separator}page=${page}`);
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return rows;
}
