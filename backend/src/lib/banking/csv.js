import { createHash } from 'node:crypto';
import { z } from 'zod';
import { businessRule } from '../accounting/errors.js';

export const MAX_STATEMENT_ROWS = 5000;

// Only these two survive a bank statement in practice (§7 edge cases table:
// "DD/MM/YYYY vs YYYY-MM-DD"). Anything else is rejected rather than guessed
// — an ambiguous date silently parsed wrong is worse than an upload that fails.
const DATE_FORMATS = ['YYYY-MM-DD', 'DD/MM/YYYY'];

export function fileSha256(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

// RFC4180-ish: quoted fields, "" escapes a literal quote, commas inside
// quotes don't split. Strips a leading BOM and normalises CRLF, and drops
// wholly-blank trailing rows (§7 edge cases: BOM, CRLF, trailing blank rows).
export function parseCsvText(text) {
  const noBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const clean = noBom.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (inQuotes) {
      if (c === '"') {
        if (clean[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

// Nepali lakh grouping ("1,25,000.00") doesn't follow 3-digit Western
// grouping, so a locale-aware parser would guess wrong — strip every comma
// and space instead of trying to interpret them.
function normaliseAmount(raw) {
  if (raw == null || raw.trim() === '') return null;
  const cleaned = raw.replace(/[,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return undefined;
  return cleaned;
}

function normaliseDate(raw, format) {
  const value = raw.trim();
  if (format === 'YYYY-MM-DD') {
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
  }
  if (format === 'DD/MM/YYYY') {
    const m = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : undefined;
  }
  return undefined;
}

const NormalisedRowSchema = z.object({
  rowIndex: z.number().int().nonnegative(),
  txnDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string().min(1),
  reference: z.string().nullable(),
  debit: z.string(),
  credit: z.string(),
  runningBalance: z.string().nullable(),
}).refine((r) => !(Number(r.debit) > 0 && Number(r.credit) > 0), 'a row cannot have both a debit and a credit')
  .refine((r) => Number(r.debit) > 0 || Number(r.credit) > 0, 'a row needs a nonzero debit or credit');

// columnMapping: { dateFormat: 'YYYY-MM-DD'|'DD/MM/YYYY',
//   columns: { date, description, reference?, balance?, debit, credit } |
//            { date, description, reference?, balance?, amount } }
// amount > 0 is read as a credit (money in), amount < 0 as a debit (money
// out) — the sign convention a column-mapping UI would let the user confirm.
//
// All-or-nothing (§7): every row is checked before any row is returned:
// throws with the full list of per-row errors rather than a partial result.
export function parseAndValidateStatement(csvText, columnMapping) {
  if (!DATE_FORMATS.includes(columnMapping.dateFormat)) {
    throw businessRule('unsupported_date_format', `dateFormat must be one of ${DATE_FORMATS.join(', ')}`);
  }

  const table = parseCsvText(csvText);
  if (table.length < 2) throw businessRule('empty_statement', 'CSV has no data rows');

  const header = table[0].map((h) => h.trim());
  const dataRows = table.slice(1);
  if (dataRows.length > MAX_STATEMENT_ROWS) {
    throw businessRule('too_many_rows', `Statement has ${dataRows.length} rows, maximum is ${MAX_STATEMENT_ROWS}`);
  }

  const { columns } = columnMapping;
  const colIndex = {};
  for (const [field, headerName] of Object.entries(columns)) {
    const idx = header.indexOf(headerName);
    if (idx === -1) throw businessRule('unmapped_column', `Column "${headerName}" not found in statement header`);
    colIndex[field] = idx;
  }

  const rows = [];
  const errors = [];

  dataRows.forEach((cells, i) => {
    const cell = (field) => (colIndex[field] != null ? (cells[colIndex[field]] ?? '') : '');

    const txnDate = normaliseDate(cell('date'), columnMapping.dateFormat);
    if (txnDate === undefined) {
      errors.push({ rowIndex: i, message: `Unparseable date "${cell('date')}"` });
      return;
    }

    const description = cell('description').trim();
    const reference = colIndex.reference != null ? (cell('reference').trim() || null) : null;
    const runningBalance = colIndex.balance != null ? normaliseAmount(cell('balance')) ?? null : null;

    let debit = '0';
    let credit = '0';
    if (colIndex.amount != null) {
      const amount = normaliseAmount(cell('amount'));
      if (amount === undefined) {
        errors.push({ rowIndex: i, message: `Unparseable amount "${cell('amount')}"` });
        return;
      }
      if (Number(amount) >= 0) credit = amount; else debit = amount.slice(1);
    } else {
      const debitRaw = normaliseAmount(cell('debit'));
      const creditRaw = normaliseAmount(cell('credit'));
      if (debitRaw === undefined || creditRaw === undefined) {
        errors.push({ rowIndex: i, message: `Unparseable amount in row ${i}` });
        return;
      }
      debit = debitRaw ?? '0';
      credit = creditRaw ?? '0';
    }

    const candidate = { rowIndex: i, txnDate, description, reference, debit, credit, runningBalance };
    const parsed = NormalisedRowSchema.safeParse(candidate);
    if (!parsed.success) {
      errors.push({ rowIndex: i, message: parsed.error.issues[0].message });
      return;
    }
    rows.push(parsed.data);
  });

  if (errors.length > 0) {
    const err = businessRule('invalid_statement_rows', 'One or more rows failed validation');
    err.details = errors;
    throw err;
  }

  return rows;
}

// The row index is part of the hash on purpose (§7): two identical NPR 5,000
// transfers on the same day are legitimate and must both survive import.
export function rowHash({ txnDate, debit, credit, description, runningBalance, rowIndex }) {
  return createHash('sha256')
    .update(`${txnDate}|${debit}|${credit}|${description}|${runningBalance ?? ''}|${rowIndex}`, 'utf8')
    .digest('hex');
}
