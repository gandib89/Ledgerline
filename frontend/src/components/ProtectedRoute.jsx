import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/auth-context.js';
import { AsyncState } from './AsyncState.jsx';

export function ProtectedRoute() {
  const { status } = useAuth();
  const location = useLocation();

  // Redirecting while the boot refresh is still in flight would log the user
  // out on every page reload.
  if (status === 'restoring') {
    return <AsyncState title="Restoring your session" message="Checking for an existing sign-in." />;
  }

  if (status !== 'authenticated') {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <Outlet />;
}
