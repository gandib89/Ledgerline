import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AsyncState } from './AsyncState.jsx';

describe('AsyncState', () => {
  it('announces progress politely by default', () => {
    render(<AsyncState title="Loading invoices" message="Fetching records." />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading invoices');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('announces recoverable errors immediately', () => {
    render(<AsyncState tone="error" title="Invoices unavailable" message="Try again." />);
    expect(screen.getByRole('alert')).toHaveTextContent('Invoices unavailableTry again.');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('renders an idle empty state without the loading treatment', () => {
    render(<AsyncState tone="empty" title="No invoices" message="Create the first invoice." />);
    expect(screen.getByRole('status')).toHaveClass('async-state-empty');
  });
});
