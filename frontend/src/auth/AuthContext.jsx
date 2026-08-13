import { useEffect, useMemo, useRef, useState } from 'react';
import { apiRequest, resetApiClient, setAccessToken } from '../lib/api-client.js';
import { AuthContext } from './auth-context.js';

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  // 'restoring' is the boot state: we hold an httpOnly refresh cookie the JS
  // cannot read, so the only way to know if a session exists is to try it.
  // Without this state ProtectedRoute would bounce every reload to /login.
  const [status, setStatus] = useState('restoring');
  const restoreStarted = useRef(false);

  useEffect(() => {
    // StrictMode runs effects twice in dev. A second /auth/refresh with the same
    // cookie is exactly the replay that trips reuse detection and revokes the
    // family — so the attempt is guarded to fire once.
    if (restoreStarted.current) return;
    restoreStarted.current = true;

    apiRequest('/auth/refresh', { method: 'POST', retryAuth: false })
      .then((session) => {
        setAccessToken(session.accessToken);
        setUser(session.user);
        setStatus('authenticated');
      })
      .catch(() => {
        // No cookie, or it expired//was revoked. Not an error — just logged out.
        setStatus('unauthenticated');
      });
  }, []);

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
