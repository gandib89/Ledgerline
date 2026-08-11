import { formatMoney } from '../lib/money.js';

export function Money({ value, currency = 'NPR', className = '' }) {
  const formatted = formatMoney(value, { currency });

  return (
    <span className={`money ${className}`.trim()} aria-label={formatted}>
      {formatted}
    </span>
  );
}
