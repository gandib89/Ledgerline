import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Money } from './Money.jsx';

describe('Money', () => {
  it('renders an accessible, tabular money value', () => {
    render(<Money value="69500" />);

    const amount = screen.getByText(
      (_, node) => node?.classList?.contains('money') && node.textContent === 'NPR\u00a069,500.00',
    );
    expect(amount).toHaveClass('money');
    expect(amount).toHaveAttribute('aria-label', 'NPR\u00a069,500.00');
    expect(amount).toHaveTextContent('NPR 69,500.00');
  });
});
