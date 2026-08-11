import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/auth-context.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validate({ name, email, password, confirmation }) {
  const errors = {};
  if (name.trim().length < 2) errors.name = 'Enter your full name';
  if (!EMAIL_PATTERN.test(email)) errors.email = 'Enter a valid email address';
  if (password.length < 8) errors.password = 'Password must be at least 8 characters';
  if (confirmation !== password) errors.confirmation = 'Passwords must match';
  return errors;
}

export function RegisterPage() {
  const [fields, setFields] = useState({ name: '', email: '', password: '', confirmation: '' });
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState('');
  const { register, status } = useAuth();
  const navigate = useNavigate();

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
      await register({ name: fields.name.trim(), email: fields.email, password: fields.password });
      navigate('/dashboard', { replace: true });
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
          <p className="eyebrow">Built for accountable growth</p>
          <p className="auth-story-title">One workspace. Every financial fact.</p>
          <p>
            Keep organizations separate, preserve every posting, and derive every report from
            the ledger your team can trust.
          </p>
        </div>
        <div className="trust-line">NPR · 13% VAT · FY 2082/83</div>
      </section>

      <section className="auth-panel">
        <div className="auth-card">
          <p className="eyebrow">Create your workspace</p>
          <h1>Start with your account</h1>
          <p className="auth-intro">Your first organization comes next.</p>

          {serverError && <div className="form-alert" role="alert">{serverError}</div>}

          <form className="auth-form" onSubmit={handleSubmit} noValidate>
            <label htmlFor="register-name">Full name</label>
            <input id="register-name" name="name" autoComplete="name" value={fields.name} onChange={updateField} aria-invalid={Boolean(errors.name)} aria-describedby={errors.name ? 'register-name-error' : undefined} />
            {errors.name && <p className="field-error" id="register-name-error">{errors.name}</p>}

            <label htmlFor="register-email">Email address</label>
            <input id="register-email" name="email" type="email" autoComplete="email" value={fields.email} onChange={updateField} aria-invalid={Boolean(errors.email)} aria-describedby={errors.email ? 'register-email-error' : undefined} />
            {errors.email && <p className="field-error" id="register-email-error">{errors.email}</p>}

            <label htmlFor="register-password">Password</label>
            <input id="register-password" name="password" type="password" autoComplete="new-password" value={fields.password} onChange={updateField} aria-invalid={Boolean(errors.password)} aria-describedby={errors.password ? 'register-password-error' : undefined} />
            {errors.password && <p className="field-error" id="register-password-error">{errors.password}</p>}

            <label htmlFor="register-confirmation">Confirm password</label>
            <input id="register-confirmation" name="confirmation" type="password" autoComplete="new-password" value={fields.confirmation} onChange={updateField} aria-invalid={Boolean(errors.confirmation)} aria-describedby={errors.confirmation ? 'register-confirmation-error' : undefined} />
            {errors.confirmation && <p className="field-error" id="register-confirmation-error">{errors.confirmation}</p>}

            <button className="primary-button" type="submit" disabled={busy}>
              {busy ? 'Creating account…' : 'Create account'}
            </button>
          </form>

          <p className="auth-switch">
            Already have an account? <Link to="/login">Sign in</Link>
          </p>
        </div>
      </section>
    </main>
  );
}
