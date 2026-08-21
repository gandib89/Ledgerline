const paths = {
  dashboard: 'M4 4h6v6H4V4Zm10 0h6v10h-6V4ZM4 14h6v6H4v-6Zm10 4h6v2h-6v-2Z',
  customers: 'M16 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m7-10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm13 10v-2a4 4 0 0 0-3-3.87m0-8a4 4 0 0 1 0 7.75',
  invoices: 'M6 2h9l3 3v17H6V2Zm9 0v4h4M9 11h6M9 15h6M9 19h4',
  receipts: 'M5 3h14v18l-3-2-3 2-3-2-3 2-2-1.4V3Zm4 5h6m-6 4h6m-6 4h4',
  banking: 'M3 10h18M5 10v8m4-8v8m6-8v8m4-8v8M2 21h20M12 3 2 8h20L12 3Z',
  reports: 'M4 20V10m6 10V4m6 16v-7m4 7H2',
  audit: 'M12 22a10 10 0 1 0-10-10 10 10 0 0 0 10 10Zm0-15v5l3 2',
  journals: 'M4 4h16v16H4V4Zm4 4h8M8 12h8M8 16h5',
  settings: 'M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5Zm8-3.5 2-1-2-3.46-2.23.3A8 8 0 0 0 16 6.8L15.5 4h-4L11 6.8a8 8 0 0 0-1.77 1.04L7 7.54 5 11l2 1-2 1 2 3.46 2.23-.3A8 8 0 0 0 11 17.2l.5 2.8h4l.5-2.8a8 8 0 0 0 1.77-1.04l2.23.3L22 13l-2-1Z',
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'm6 6 12 12M18 6 6 18',
};

export function Icon({ name, size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}
