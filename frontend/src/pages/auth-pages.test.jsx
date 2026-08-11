import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AuthProvider } from '../auth/AuthContext.jsx';
import { ProtectedRoute } from '../components/ProtectedRoute.jsx';
import { createAppQueryClient } from '../query-client.js';
import { LoginPage } from './LoginPage.jsx';
import { RegisterPage } from './RegisterPage.jsx';

function renderAuthRoute(initialEntry = '/login') {
  return render(
    <QueryClientProvider client={createAppQueryClient()}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route element={<ProtectedRoute />}>
              <Route path="/dashboard" element={<h1>Financial control center</h1>} />
            </Route>
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('authentication pages', () => {
  it('shows field errors when login is submitted empty', async () => {
    const user = userEvent.setup();
    renderAuthRoute();

    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(screen.getByText('Enter a valid email address')).toBeInTheDocument();
    expect(screen.getByText('Password must be at least 8 characters')).toBeInTheDocument();
  });

  it('shows the API error for invalid credentials', async () => {
    const user = userEvent.setup();
    renderAuthRoute();

    await user.type(screen.getByLabelText('Email address'), 'wrong@example.com');
    await user.type(screen.getByLabelText('Password'), 'wrongpass');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is incorrect');
  });

  it('navigates to the intended protected page after login', async () => {
    const user = userEvent.setup();
    renderAuthRoute('/dashboard');

    expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Email address'), 'demo@ledgerline.app');
    await user.type(screen.getByLabelText('Password'), 'ledger123');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: 'Financial control center' })).toBeInTheDocument();
  });

  it('validates registration password confirmation', async () => {
    const user = userEvent.setup();
    renderAuthRoute('/register');

    await user.type(screen.getByLabelText('Full name'), 'Maya Gurung');
    await user.type(screen.getByLabelText('Email address'), 'maya@example.com');
    await user.type(screen.getByLabelText('Password'), 'ledger123');
    await user.type(screen.getByLabelText('Confirm password'), 'ledger456');
    await user.click(screen.getByRole('button', { name: 'Create account' }));

    expect(screen.getByText('Passwords must match')).toBeInTheDocument();
  });
});
