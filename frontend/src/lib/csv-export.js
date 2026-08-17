function safeCell(value) {
  const text = String(value ?? '');
  const escapedFormula = /^[\t\r ]*[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(escapedFormula)
    ? `"${escapedFormula.replaceAll('"', '""')}"`
    : escapedFormula;
}

export function toCsv(columns, rows) {
  const header = columns.map(({ label }) => safeCell(label)).join(',');
  const body = rows.map((row) => columns.map(({ key, value }) => safeCell(value ? value(row) : row[key])).join(','));
  return [header, ...body].join('\r\n');
}

export function downloadCsv(filename, columns, rows) {
  const url = URL.createObjectURL(new Blob([`\uFEFF${toCsv(columns, rows)}`], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
