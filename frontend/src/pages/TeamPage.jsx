import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { AsyncState } from '../components/AsyncState.jsx';
import { apiRequest } from '../lib/api-client.js';
import { useToast } from '../components/toast-context.js';

const EMPTY_FORM = { email: '', roleId: '' };

export function TeamPage() {
  const { activeOrganizationId, activeOrganization } = useOutletContext();
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState({});
  const canManageOrg = Boolean(activeOrganization?.permissions?.includes('org.manage'));

  const members = useQuery({
    queryKey: ['org-members', activeOrganizationId],
    queryFn: () => apiRequest(`/orgs/${activeOrganizationId}/members`),
    enabled: Boolean(activeOrganizationId) && canManageOrg,
  });
  // Only needed to populate the drawer's role picker, so it waits for the
  // drawer to actually open rather than firing on every page load.
  const roles = useQuery({
    queryKey: ['roles', activeOrganizationId],
    queryFn: () => apiRequest('/roles'),
    enabled: Boolean(activeOrganizationId) && drawerOpen,
  });

  const addMember = useMutation({
    mutationFn: () => apiRequest(`/orgs/${activeOrganizationId}/members`, {
      method: 'POST',
      body: { email: form.email.trim(), roleId: form.roleId },
    }),
    onSuccess: (member) => {
      queryClient.invalidateQueries({ queryKey: ['org-members'] });
      notify({ title: 'Member added', message: `${member.user.email} · ${member.role.name}`, tone: 'success' });
      closeDrawer();
    },
    onError: (error) => notify({ title: 'Could not add member', message: error.message, tone: 'error' }),
  });

  function closeDrawer() {
    setDrawerOpen(false);
    setForm(EMPTY_FORM);
    setErrors({});
  }

  function submit(event) {
    event.preventDefault();
    const found = {};
    if (!form.email.trim()) found.email = 'Email is required';
    if (!form.roleId) found.roleId = 'Role is required';
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    addMember.mutate();
  }

  if (!canManageOrg) {
    return (
      <div className="team-page">
        <div className="page-heading">
          <div>
            <p className="eyebrow">Masters</p>
            <h1>Team</h1>
            <p>Who has access to this organization's books.</p>
          </div>
        </div>
        <AsyncState tone="empty" title="Owners only" message="Ask an organization owner to manage team access." />
      </div>
    );
  }

  return (
    <div className="team-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Masters</p>
          <h1>Team</h1>
          <p>Who has access to this organization's books.</p>
        </div>
        <button className="primary-button" type="button" onClick={() => setDrawerOpen(true)}>
          Add member
        </button>
      </div>

      {members.isPending ? (
        <AsyncState title="Loading team" message="Fetching this organization's members." />
      ) : members.isError ? (
        <AsyncState tone="error" title="Team unavailable" message={members.error.message} />
      ) : members.data.length === 0 ? (
        <AsyncState tone="empty" title="No members yet" message="Add your first teammate to share this organization's books." />
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Email</th>
              <th scope="col">Role</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {members.data.map((member) => (
              <tr key={member.id}>
                <td>{member.user.email}</td>
                <td>{member.role.name}</td>
                <td>{member.isActive ? 'Active' : <span className="badge">Inactive</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {drawerOpen && (
        <div className="drawer" role="dialog" aria-modal="true" aria-label="Add member">
          <form className="drawer-panel" onSubmit={submit} noValidate>
            <h2>Add member</h2>
            <p className="muted-copy">
              They must already have a Ledgerline account — this adds an existing user to this
              organization, it doesn't send an invite email.
            </p>

            <label>
              Email
              <input
                type="email"
                autoFocus
                value={form.email}
                onChange={(e) => setForm((current) => ({ ...current, email: e.target.value }))}
                aria-invalid={Boolean(errors.email)}
              />
              {errors.email && <span className="field-error" role="alert">{errors.email}</span>}
            </label>

            <label>
              Role
              <select
                value={form.roleId}
                onChange={(e) => setForm((current) => ({ ...current, roleId: e.target.value }))}
                aria-invalid={Boolean(errors.roleId)}
              >
                <option value="">Select role</option>
                {roles.data?.map((role) => (
                  <option key={role.id} value={role.id}>{role.name}</option>
                ))}
              </select>
              {errors.roleId && <span className="field-error" role="alert">{errors.roleId}</span>}
            </label>

            <div className="drawer-actions">
              <button className="secondary-button" type="button" onClick={closeDrawer}>
                Cancel
              </button>
              <button className="primary-button" type="submit" disabled={addMember.isPending}>
                {addMember.isPending ? 'Adding…' : 'Add member'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
