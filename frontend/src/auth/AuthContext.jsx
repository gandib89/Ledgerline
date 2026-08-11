import { useMemo, useState } from 'react';
import { apiRequest, resetApiClient, setAccessToken } from '../lib/api-client.js';
import { AuthContext } from './auth-context.js';

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState('unauthenticated');

  async function authenticate(path, input) {
    setStatus('authenticating');
    try {
      const session = await apiRequest(path, { method: 'POST', body: input, retryAuth: false });
      setAccessToken(session.accessToken);
      setUser(session.user);
      setStatus('authenticated');
      return session.user;
    } catch (error) {
      setStatus('unauthenticated');
      throw error;
    }
  }

  async function logout() {
    try {
      await apiRequest('/auth/logout', { method: 'POST' });
    } finally {
      resetApiClient();
      setUser(null);
      setStatus('unauthenticated');
    }
  }

  const value = useMemo(
    () => ({
      user,
      status,
      login: (input) => authenticate('/auth/login', input),
      register: (input) => authenticate('/auth/register', input),
      logout,
    }),
    [status, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
