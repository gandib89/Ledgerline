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

function listPath({ partyId, status, page }) {
  const params = new URLSearchParams({ page: String(page) });
  if (partyId) params.set('partyId', partyId);
  if (status) params.set('status', status);
  return `/bills?${params}`;
}

export function BillsPage() {
  const { activeOrganizationId, activeOrganization } = useOutletContext();
  const canCreate = Boolean(activeOrganization?.permissions?.includes('bill.create'));
  const [filters, setFilters] = useState({ partyId: '', status: '', page: 1 });
  const suppliers = useQuery({
    queryKey: ['parties', activeOrganizationId, 'bill-supplier-selector'],
    queryFn: () => apiRequest('/parties?type=supplier&page=1'),
    enabled: Boolean(activeOrganizationId),
  });
  const bills = useQuery({
    queryKey: ['bills', activeOrganizationId, filters],
    queryFn: () => apiRequest(listPath(filters)),
    enabled: Boolean(activeOrganizationId),
  });
  const supplierNames = useMemo(
    () => Object.fromEntries((suppliers.data ?? []).map((party) => [party.id, party.name])),
    [suppliers.data],
  );

  function updateFilter(field, value) {
    setFilters((current) => ({ ...current, [field]: value, page: 1 }));
  }

  const pending = !activeOrganizationId || bills.isPending || suppliers.isPending;

  return (
    <div className="accounting-page invoices-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Payables</p>
          <h1>Bills</h1>
          <p>Record what Suppliers have billed you and check each Bill before it is posted.</p>
        </div>
        {canCreate && <Link className="primary-button button-link" to="/bills/new">New bill</Link>}
      </div>

      <section className="filter-bar" aria-label="Bill filters">
        <label>Supplier
          <select aria-label="Bill supplier" value={filters.partyId} onChange={(event) => updateFilter('partyId', event.target.value)}>
            <option value="">All suppliers</option>
            {(suppliers.data ?? []).map((party) => <option key={party.id} value={party.id}>{party.name}</option>)}
          </select>
        </label>
        <label>Status
          <select aria-label="Bill status" value={filters.status} onChange={(event) => updateFilter('status', event.target.value)}>
            <option value="">All statuses</option>
            {Object.entries(STATUS_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      </section>

      {pending ? (
        <AsyncState title="Loading bills" message="Fetching suppliers and bill records." />
      ) : bills.isError || suppliers.isError ? (
        <AsyncState tone="error" title="Bills unavailable" message={(bills.error ?? suppliers.error).message} />
      ) : bills.data.length === 0 ? (
        <AsyncState
          tone="empty"
          title="No bills found"
          message={canCreate ? 'Change the filters or enter the first bill.' : 'Change the filters — no bills match yet.'}
          action={canCreate ? <Link className="secondary-button button-link" to="/bills/new">Create bill</Link> : null}
        />
      ) : (
        <>
          <div className="table-scroll">
            <table className="data-table invoice-table">
              <thead><tr><th scope="col">Supplier reference</th><th scope="col">Bill date</th><th scope="col">Supplier</th><th scope="col">Status</th><th className="numeric" scope="col">Total</th></tr></thead>
              <tbody>
                {bills.data.map((bill) => (
                  <tr key={bill.id}>
                    <td><Link className="document-link" to={`/bills/${bill.id}`}>{bill.referenceNo}</Link></td>
                    <td>{bill.docDate}</td>
                    <td>{supplierNames[bill.partyId] ?? 'Unknown supplier'}</td>
                    <td><span className={`status-pill status-${bill.status}`}>{STATUS_LABELS[bill.status] ?? bill.status}</span></td>
                    <td className="numeric"><Money value={bill.grandTotal} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pagination">
            <button type="button" disabled={filters.page === 1} onClick={() => setFilters((current) => ({ ...current, page: current.page - 1 }))}>Previous</button>
            <span>Page {filters.page}</span>
            <button type="button" disabled={bills.data.length < PAGE_SIZE} onClick={() => setFilters((current) => ({ ...current, page: current.page + 1 }))}>Next</button>
          </div>
        </>
      )}
    </div>
  );
}
