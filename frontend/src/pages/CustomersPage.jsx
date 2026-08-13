import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { AsyncState } from '../components/AsyncState.jsx';
import { apiRequest } from '../lib/api-client.js';
import { useToast } from '../components/toast-context.js';

const PAGE_SIZE = 20;

const EMPTY_FORM = { type: 'customer', code: '', name: '', email: '', phone: '', creditDays: 30 };

// Mirrors the server's Zod schema. The server is still the authority — this
// only spares the user a round trip for obvious mistakes.
function validate(form) {
  const errors = {};
  if (!form.code.trim()) errors.code = 'Code is required';
  if (!form.name.trim()) errors.name = 'Name is required';
  if (form.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email)) errors.email = 'Enter a valid email';
  if (Number.isNaN(Number(form.creditDays)) || Number(form.creditDays) < 0) {
    errors.creditDays = 'Credit days must be 0 or more';
  }
  return errors;
}

export function CustomersPage() {
  const { activeOrganizationId } = useOutletContext();
  const queryClient = useQueryClient();
  const { notify } = useToast();

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState({});

  const parties = useQuery({
    queryKey: ['parties', activeOrganizationId, search, page],
    queryFn: () => apiRequest(`/parties?search=${encodeURIComponent(search)}&page=${page}`),
    enabled: Boolean(activeOrganizationId),
  });

  const createParty = useMutation({
    mutationFn: (input) => apiRequest('/parties', { method: 'POST', body: input }),
    onSuccess: (party) => {
      // Invalidate every page/search combination, not just the current one.
      queryClient.invalidateQueries({ queryKey: ['parties'] });
      notify({ title: 'Customer created', message: party.name, tone: 'success' });
      closeDrawer();
    },
    onError: (error) => {
      notify({ title: 'Could not create customer', message: error.message, tone: 'error' });
    },
  });

  function closeDrawer() {
    setDrawerOpen(false);
    setForm(EMPTY_FORM);
    setErrors({});
  }

  function submit(event) {
    event.preventDefault();
    const found = validate(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    createParty.mutate({
      type: form.type,
      code: form.code.trim(),
      name: form.name.trim(),
      // The server schema is .strict() — sending empty strings for optional
      // fields would fail validation, so drop them entirely.
      ...(form.email ? { email: form.email.trim() } : {}),
      ...(form.phone ? { phone: form.phone.trim() } : {}),
      creditDays: Number(form.creditDays),
    });
  }

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  return (
    <div className="customers-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Masters</p>
          <h1>Customers</h1>
          <p>Everyone you invoice, and the credit terms they trade on.</p>
        </div>
        <button className="primary-button" type="button" onClick={() => setDrawerOpen(true)}>
          New customer
        </button>
      </div>

      <div className="toolbar">
        <label className="search-field">
          <span className="visually-hidden">Search customers</span>
          <input
            type="search"
            placeholder="Search by name"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1); // a new search invalidates the current page number
            }}
          />
        </label>
      </div>

      {!activeOrganizationId || parties.isPending ? (
        <AsyncState title="Loading customers" message="Fetching this organization's customers." />
      ) : parties.isError ? (
        <AsyncState title="Customers unavailable" message={parties.error.message} />
      ) : parties.data.length === 0 ? (
        <AsyncState
          title={search ? 'No matches' : 'No customers yet'}
          message={search ? `Nothing matched “${search}”.` : 'Create your first customer to start invoicing.'}
        />
      ) : (
        <>
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Code</th>
                <th scope="col">Name</th>
                <th scope="col">Email</th>
                <th scope="col">Credit days</th>
              </tr>
            </thead>
            <tbody>
              {parties.data.map((party) => (
                <tr key={party.id}>
                  <td className="numeric">{party.code}</td>
                  <td>{party.name}</td>
                  <td>{party.email ?? '—'}</td>
                  <td className="numeric">{party.creditDays}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="pagination">
            <button type="button" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
              Previous
            </button>
            <span>Page {page}</span>
            {/* The list endpoint returns rows, not a total count, so "next" is
                offered whenever the page came back full. */}
            <button
              type="button"
              disabled={parties.data.length < PAGE_SIZE}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </>
      )}

      {drawerOpen && (
        <div className="drawer" role="dialog" aria-modal="true" aria-label="New customer">
          <form className="drawer-panel" onSubmit={submit} noValidate>
            <h2>New customer</h2>

            <label>
              Code
              <input value={form.code} onChange={(e) => update('code', e.target.value)} aria-invalid={Boolean(errors.code)} />
              {errors.code && <span className="field-error">{errors.code}</span>}
            </label>

            <label>
              Name
              <input value={form.name} onChange={(e) => update('name', e.target.value)} aria-invalid={Boolean(errors.name)} />
              {errors.name && <span className="field-error">{errors.name}</span>}
            </label>

            <label>
              Email
              <input type="email" value={form.email} onChange={(e) => update('email', e.target.value)} aria-invalid={Boolean(errors.email)} />
              {errors.email && <span className="field-error">{errors.email}</span>}
            </label>

            <label>
              Phone
              <input value={form.phone} onChange={(e) => update('phone', e.target.value)} />
            </label>

            <label>
              Credit days
              <input
                type="number"
                min="0"
                value={form.creditDays}
                onChange={(e) => update('creditDays', e.target.value)}
                aria-invalid={Boolean(errors.creditDays)}
              />
              {errors.creditDays && <span className="field-error">{errors.creditDays}</span>}
            </label>

            <div className="drawer-actions">
              <button className="secondary-button" type="button" onClick={closeDrawer}>
                Cancel
              </button>
              <button className="primary-button" type="submit" disabled={createParty.isPending}>
                {createParty.isPending ? 'Creating…' : 'Create customer'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
