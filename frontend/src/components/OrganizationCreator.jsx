import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '../lib/api-client.js';
import { useToast } from './toast-context.js';

export function OrganizationCreator({ first = false, onCreated }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const createOrganization = useMutation({
    mutationFn: (input) => apiRequest('/orgs', { method: 'POST', body: input }),
    onSuccess: async (organization) => {
      await queryClient.invalidateQueries({ queryKey: ['organizations'] });
      setName('');
      notify({ title: 'Organization created', message: organization.name, tone: 'success' });
      onCreated?.(organization);
    },
    onError: (apiError) => setError(apiError.message),
  });

  function submit(event) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) { setError('Organization name is required'); return; }
    setError('');
    createOrganization.mutate({ name: trimmed });
  }

  return (
    <section className={first ? 'onboarding-card' : 'settings-card'}>
      <div>
        <p className="eyebrow">{first ? 'First workspace' : 'Organizations'}</p>
        <h2>{first ? 'Create your first organization' : 'Create another organization'}</h2>
        <p>{first ? 'Set up the business whose books you want to manage.' : 'Keep each legal entity in an isolated workspace.'}</p>
      </div>
      <form className="compact-form" onSubmit={submit} noValidate>
        <label>Organization name<input value={name} onChange={(event) => { setName(event.target.value); setError(''); }} aria-invalid={Boolean(error)} /></label>
        {error && <span className="field-error" role="alert">{error}</span>}
        <button className="primary-button" type="submit" disabled={createOrganization.isPending}>{createOrganization.isPending ? 'Creating…' : 'Create organization'}</button>
      </form>
    </section>
  );
}
