import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { z } from 'zod';
import { AsyncState } from '../components/AsyncState.jsx';
import { apiRequest } from '../lib/api-client.js';
import { useToast } from '../components/toast-context.js';
import { createPartySchemas } from '../../../shared/party-schema.js';

const PAGE_SIZE = 20;

const EMPTY_FORM = { type: 'supplier', code: '', name: '', panVatNo: '', email: '', phone: '', creditDays: 30 };
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
    input.panVatNo = form.panVatNo.trim() || null;
    input.email = form.email.trim() || null;
    input.phone = form.phone.trim() || null;
  } else {
    if (form.panVatNo.trim()) input.panVatNo = form.panVatNo.trim();
    if (form.email.trim()) input.email = form.email.trim();
    if (form.phone.trim()) input.phone = form.phone.trim();
  }

  return input;
}

export function SuppliersPage() {
  const { activeOrganizationId, activeOrganization } = useOutletContext();
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const canManageOrg = Boolean(activeOrganization?.permissions?.includes('org.manage'));

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingParty, setEditingParty] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState({});

  const parties = useQuery({
    queryKey: ['parties', activeOrganizationId, 'supplier', search, page],
    queryFn: () => apiRequest(`/parties?type=supplier&search=${encodeURIComponent(search)}&page=${page}`),
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
      notify({ title: id ? 'Supplier updated' : 'Supplier created', message: party.name, tone: 'success' });
      closeDrawer();
    },
    onError: (error, { id }) => {
      notify({ title: id ? 'Could not update supplier' : 'Could not create supplier', message: error.message, tone: 'error' });
    },
  });

  function closeDrawer() {
    setDrawerOpen(false);
    setEditingParty(null);
    setForm(EMPTY_FORM);
    setErrors({});
  }

  function openNewSupplier() {
    setEditingParty(null);
    setForm(EMPTY_FORM);
    setErrors({});
    setDrawerOpen(true);
  }

  function openEditSupplier(party) {
    setEditingParty(party);
    setForm({
      type: party.type,
      code: party.code,
      name: party.name,
      panVatNo: party.panVatNo ?? '',
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
          <p className="eyebrow">Payables</p>
          <h1>Suppliers</h1>
          <p>Everyone you buy from, and the credit terms they give you.</p>
        </div>
        {canManageOrg && (
          <button className="primary-button" type="button" onClick={openNewSupplier}>
            New supplier
          </button>
        )}
      </div>

      <div className="toolbar">
        <label className="search-field">
          <span className="visually-hidden">Search suppliers</span>
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
        <AsyncState title="Loading suppliers" message="Fetching this organization's suppliers." />
      ) : parties.isError ? (
        <AsyncState tone="error" title="Suppliers unavailable" message={parties.error.message} />
      ) : parties.data.length === 0 ? (
        <AsyncState
          title={search ? 'No matches' : 'No suppliers yet'}
          message={search ? `Nothing matched “${search}”.` : 'Create your first supplier to start recording bills.'}
        />
      ) : (
        <>
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Code</th>
                <th scope="col">Name</th>
                <th scope="col">PAN/VAT number</th>
                <th scope="col">Credit days</th>
                <th scope="col"><span className="visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {parties.data.map((party) => (
                <tr key={party.id}>
                  <td className="numeric">{party.code}</td>
                  <td>{party.name}</td>
                  <td className="numeric">{party.panVatNo ?? '—'}</td>
                  <td className="numeric">{party.creditDays}</td>
                  <td className="table-actions">
                    {canManageOrg && (
                      <button
                        className="table-action"
                        type="button"
                        aria-label={`Edit ${party.name}`}
                        onClick={() => openEditSupplier(party)}
                      >
                        Edit
                      </button>
                    )}
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
          aria-label={editingParty ? 'Edit supplier' : 'New supplier'}
        >
          <form className="drawer-panel" onSubmit={submit} noValidate>
            <h2>{editingParty ? 'Edit supplier' : 'New supplier'}</h2>

            <label>
              Type
              <select value={form.type} onChange={(e) => update('type', e.target.value)}>
                <option value="supplier">Supplier</option>
                <option value="both">Both customer and supplier</option>
              </select>
            </label>

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
              PAN/VAT number
              <input value={form.panVatNo} onChange={(e) => update('panVatNo', e.target.value)} />
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
                  : (editingParty ? 'Save changes' : 'Create supplier')}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
