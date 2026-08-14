import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useOutletContext } from 'react-router-dom';
import { AsyncState } from '../components/AsyncState.jsx';
import { Money } from '../components/Money.jsx';
import { apiRequest } from '../lib/api-client.js';

const PAGE_SIZE = 20;
const STATUS_LABELS = {
  draft: 'Draft',
  posted: 'Posted',
  partially_paid: 'Partially paid',
  paid: 'Paid',
  reversed: 'Reversed',
};

function listPath({ partyId, status, from, to, page }) {
  const params = new URLSearchParams({ page: String(page) });
  if (partyId) params.set('partyId', partyId);
  if (status) params.set('status', status);
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  return `/invoices?${params}`;
}

export function InvoicesPage() {
  const { activeOrganizationId } = useOutletContext();
  const [filters, setFilters] = useState({ partyId: '', status: '', from: '', to: '', page: 1 });
  const parties = useQuery({
    queryKey: ['parties', activeOrganizationId, 'invoice-selector'],
    queryFn: () => apiRequest('/parties?page=1'),
    enabled: Boolean(activeOrganizationId),
  });
  const invoices = useQuery({
    queryKey: ['invoices', activeOrganizationId, filters],
    queryFn: () => apiRequest(listPath(filters)),
    enabled: Boolean(activeOrganizationId),
  });
  const partyNames = useMemo(
    () => Object.fromEntries((parties.data ?? []).map((party) => [party.id, party.name])),
    [parties.data],
  );

  function updateFilter(field, value) {
    setFilters((current) => ({ ...current, [field]: value, page: 1 }));
  }

  const pending = !activeOrganizationId || invoices.isPending || parties.isPending;

  return (
    <div className="accounting-page invoices-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Sales ledger</p>
          <h1>Invoices</h1>
          <p>Prepare customer invoices, track what remains due, and open the accounting entry.</p>
        </div>
        <Link className="primary-button button-link" to="/invoices/new">New invoice</Link>
      </div>

      <section className="filter-bar" aria-label="Invoice filters">
        <label>Customer
          <select aria-label="Invoice customer" value={filters.partyId} onChange={(event) => updateFilter('partyId', event.target.value)}>
            <option value="">All customers</option>
            {(parties.data ?? []).map((party) => <option key={party.id} value={party.id}>{party.name}</option>)}
          </select>
        </label>
        <label>Status
          <select aria-label="Invoice status" value={filters.status} onChange={(event) => updateFilter('status', event.target.value)}>
            <option value="">All statuses</option>
            {Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label>From
          <input aria-label="Invoices from" type="date" value={filters.from} onChange={(event) => updateFilter('from', event.target.value)} />
        </label>
        <label>To
          <input aria-label="Invoices to" type="date" value={filters.to} min={filters.from || undefined} onChange={(event) => updateFilter('to', event.target.value)} />
        </label>
      </section>

      {pending ? (
        <AsyncState title="Loading invoices" message="Fetching customers and invoice records." />
      ) : invoices.isError || parties.isError ? (
        <AsyncState title="Invoices unavailable" message={(invoices.error ?? parties.error).message} />
      ) : invoices.data.length === 0 ? (
        <AsyncState title="No invoices found" message="Change the filters or prepare the first invoice." action={<Link className="secondary-button button-link" to="/invoices/new">Create invoice</Link>} />
      ) : (
        <>
          <div className="table-scroll">
            <table className="data-table invoice-table">
              <thead><tr><th scope="col">Invoice</th><th scope="col">Date</th><th scope="col">Customer</th><th scope="col">Status</th><th className="numeric" scope="col">Outstanding</th></tr></thead>
              <tbody>
                {invoices.data.map((invoice) => (
                  <tr key={invoice.id}>
                    <td><Link className="document-link" to={`/invoices/${invoice.id}`}>{invoice.docNo ?? 'Unnumbered draft'}</Link></td>
                    <td>{invoice.docDate}</td>
                    <td>{partyNames[invoice.partyId] ?? 'Unknown customer'}</td>
                    <td><span className={`status-pill status-${invoice.status}`}>{STATUS_LABELS[invoice.status] ?? invoice.status}</span></td>
                    <td className="numeric"><Money value={invoice.outstandingAmount} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pagination">
            <button type="button" disabled={filters.page === 1} onClick={() => setFilters((current) => ({ ...current, page: current.page - 1 }))}>Previous</button>
            <span>Page {filters.page}</span>
            <button type="button" disabled={invoices.data.length < PAGE_SIZE} onClick={() => setFilters((current) => ({ ...current, page: current.page + 1 }))}>Next</button>
          </div>
        </>
      )}
    </div>
  );
}
