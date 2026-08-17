import { describe, expect, it, vi } from 'vitest';
import { downloadCsv, toCsv } from './csv-export.js';

describe('safe CSV export', () => {
  const columns = [
    { key: 'name', label: 'Name' },
    { key: 'amount', label: 'Amount' },
  ];

  it('quotes commas and escapes spreadsheet formulas', () => {
    expect(toCsv(columns, [{ name: '=cmd', amount: '1,200.00' }]))
      .toBe("Name,Amount\r\n'=cmd,\"1,200.00\"");
  });

  it('downloads a CSV and releases the temporary URL', () => {
    const click = vi.fn();
    const anchor = { click, remove: vi.fn(), set href(value) { this._href = value; }, set download(value) { this._download = value; } };
    vi.spyOn(document, 'createElement').mockReturnValue(anchor);
    const createObjectURL = vi.fn(() => 'blob:ledgerline');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });

    downloadCsv('report.csv', columns, [{ name: 'Revenue', amount: '100.00' }]);

    expect(anchor._download).toBe('report.csv');
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:ledgerline');
  });
});
