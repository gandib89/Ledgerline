import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/auth-context.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validate({ email, password }) {
  const errors = {};
  if (!EMAIL_PATTERN.test(email)) errors.email = 'Enter a valid email address';
  if (password.length < 8) errors.password = 'Password must be at least 8 characters';
  return errors;
}

export function LoginPage() {
  const [fields, setFields] = useState({ email: '', password: '' });
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState('');
  const { login, status } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  function updateField(event) {
    setFields((current) => ({ ...current, [event.target.name]: event.target.value }));
    setErrors((current) => ({ ...current, [event.target.name]: undefined }));
    setServerError('');
  }

  async function handleSubmit(event) {
    event.preventDefault();
    const nextErrors = validate(fields);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;

    try {
      await login(fields);
      navigate(location.state?.from?.pathname ?? '/dashboard', { replace: true });
    } catch (error) {
      setServerError(error.message);
    }
  }

  const busy = status === 'authenticating';

  return (
    <main className="auth-page">
      <section className="auth-story" aria-label="Ledgerline introduction">
        <Link className="brand brand-on-dark" to="/login" aria-label="Ledgerline home">
          <span className="brand-mark" aria-hidden="true">L</span>
          <span>Ledgerline</span>
        </Link>
        <div className="auth-story-copy">
          <p className="eyebrow">Financial clarity, line by line</p>
          <p className="auth-story-title">Your books should explain themselves.</p>
          <p>
            Every invoice, receipt, and bank movement resolves into one immutable ledger—ready
            for review, reconciliation, and reporting.
          </p>
        </div>
        <div className="ledger-preview" aria-hidden="true">
          <span>INV-2082-0001</span>
          <strong>Dr = Cr</strong>
          <span>NPR 113,000.00</span>
        </div>
      </section>

      <section className="auth-panel">
        <div className="auth-card">
          <p className="eyebrow">Secure workspace</p>
          <h1>Welcome back</h1>
          <p className="auth-intro">Sign in to continue to your organizations and ledgers.</p>

          {serverError && <div className="form-alert" role="alert">{serverError}</div>}

          <form className="auth-form" onSubmit={handleSubmit} noValidate>
            <label htmlFor="login-email">Email address</label>
            <input
              id="login-email"
              name="email"
              type="email"
              autoComplete="email"
              value={fields.email}
              onChange={updateField}
              aria-invalid={Boolean(errors.email)}
              aria-describedby={errors.email ? 'login-email-error' : undefined}
            />
            {errors.email && <p className="field-error" id="login-email-error">{errors.email}</p>}

            <label htmlFor="login-password">Password</label>
            <input
              id="login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={fields.password}
              onChange={updateField}
              aria-invalid={Boolean(errors.password)}
              aria-describedby={errors.password ? 'login-password-error' : undefined}
            />
            {errors.password && (
              <p className="field-error" id="login-password-error">{errors.password}</p>
            )}

            <button className="primary-button" type="submit" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <div className="demo-credentials">
            <span>Demo access</span>
            <code>demo@ledgerline.app</code>
            <code>ledger123</code>
          </div>

          <p className="auth-switch">
            New to Ledgerline? <Link to="/register">Create an account</Link>
          </p>
        </div>
      </section>
    </main>
  );
}
