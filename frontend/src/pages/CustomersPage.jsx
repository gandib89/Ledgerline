import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { z } from 'zod';
import { AsyncState } from '../components/AsyncState.jsx';
import { apiRequest } from '../lib/api-client.js';
import { useToast } from '../components/toast-context.js';
import { createPartySchemas } from '../../../shared/party-schema.js';

const PAGE_SIZE = 20;

const EMPTY_FORM = { type: 'customer', code: '', name: '', email: '', phone: '', creditDays: 30 };
const { createPartySchema, updatePartySchema } = createPartySchemas(z);

function validationErrors(result) {
  if (result.success) return {};
  return Object.fromEntries(result.error.issues.map((issue) => [issue.path[0], issue.message]));
}

function partyInput(form, editing) {
  const input = {
    type: form.type,
    code: form.code.trim(),
    name: form.name.trim(),
    creditDays: Number(form.creditDays),
  };

  if (editing) {
    input.email = form.email.trim() || null;
    input.phone = form.phone.trim() || null;
  } else {
    if (form.email.trim()) input.email = form.email.trim();
    if (form.phone.trim()) input.phone = form.phone.trim();
  }

  return input;
}

export function CustomersPage() {
  const { activeOrganizationId } = useOutletContext();
  const queryClient = useQueryClient();
  const { notify } = useToast();

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingParty, setEditingParty] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState({});

  const parties = useQuery({
    queryKey: ['parties', activeOrganizationId, search, page],
    queryFn: () => apiRequest(`/parties?search=${encodeURIComponent(search)}&page=${page}`),
    enabled: Boolean(activeOrganizationId),
  });

  const saveParty = useMutation({
    mutationFn: ({ id, input }) => apiRequest(id ? `/parties/${id}` : '/parties', {
      method: id ? 'PATCH' : 'POST',
      body: input,
    }),
    onSuccess: (party, { id }) => {
      // Invalidate every page/search combination, not just the current one.
      queryClient.invalidateQueries({ queryKey: ['parties'] });
      notify({ title: id ? 'Customer updated' : 'Customer created', message: party.name, tone: 'success' });
      closeDrawer();
    },
    onError: (error, { id }) => {
      notify({ title: id ? 'Could not update customer' : 'Could not create customer', message: error.message, tone: 'error' });
    },
  });

  function closeDrawer() {
    setDrawerOpen(false);
    setEditingParty(null);
    setForm(EMPTY_FORM);
    setErrors({});
  }

  function openNewCustomer() {
    setEditingParty(null);
    setForm(EMPTY_FORM);
    setErrors({});
    setDrawerOpen(true);
  }

  function openEditCustomer(party) {
    setEditingParty(party);
    setForm({
      type: party.type,
      code: party.code,
      name: party.name,
      email: party.email ?? '',
      phone: party.phone ?? '',
      creditDays: party.creditDays,
    });
    setErrors({});
    setDrawerOpen(true);
  }

  function submit(event) {
    event.preventDefault();
    const input = partyInput(form, Boolean(editingParty));
    const schema = editingParty ? updatePartySchema : createPartySchema;
    const parsed = schema.safeParse(input);
    const found = validationErrors(parsed);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    saveParty.mutate({ id: editingParty?.id, input: parsed.data });
  }

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  }

  return (
    <div className="customers-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Masters</p>
          <h1>Customers</h1>
          <p>Everyone you invoice, and the credit terms they trade on.</p>
        </div>
        <button className="primary-button" type="button" onClick={openNewCustomer}>
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
        <AsyncState tone="error" title="Customers unavailable" message={parties.error.message} />
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
                <th scope="col"><span className="visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {parties.data.map((party) => (
                <tr key={party.id}>
                  <td className="numeric">{party.code}</td>
                  <td>{party.name}</td>
                  <td>{party.email ?? '—'}</td>
                  <td className="numeric">{party.creditDays}</td>
                  <td className="table-actions">
                    <button
                      className="table-action"
                      type="button"
                      aria-label={`Edit ${party.name}`}
                      onClick={() => openEditCustomer(party)}
                    >
                      Edit
                    </button>
                  </td>
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
        <div
          className="drawer"
          role="dialog"
          aria-modal="true"
          aria-label={editingParty ? 'Edit customer' : 'New customer'}
        >
          <form className="drawer-panel" onSubmit={submit} noValidate>
            <h2>{editingParty ? 'Edit customer' : 'New customer'}</h2>

            <label>
              Code
              <input autoFocus={!editingParty} value={form.code} onChange={(e) => update('code', e.target.value)} aria-invalid={Boolean(errors.code)} />
              {errors.code && <span className="field-error" role="alert">{errors.code}</span>}
            </label>

            <label>
              Name
              <input autoFocus={Boolean(editingParty)} value={form.name} onChange={(e) => update('name', e.target.value)} aria-invalid={Boolean(errors.name)} />
              {errors.name && <span className="field-error" role="alert">{errors.name}</span>}
            </label>

            <label>
              Email
              <input type="email" value={form.email} onChange={(e) => update('email', e.target.value)} aria-invalid={Boolean(errors.email)} />
              {errors.email && <span className="field-error" role="alert">{errors.email}</span>}
            </label>

            <label>
              Phone
              <input type="tel" value={form.phone} onChange={(e) => update('phone', e.target.value)} />
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
              {errors.creditDays && <span className="field-error" role="alert">{errors.creditDays}</span>}
            </label>

            <div className="drawer-actions">
              <button className="secondary-button" type="button" onClick={closeDrawer}>
                Cancel
              </button>
              <button className="primary-button" type="submit" disabled={saveParty.isPending}>
                {saveParty.isPending
                  ? (editingParty ? 'Saving…' : 'Creating…')
                  : (editingParty ? 'Save changes' : 'Create customer')}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
