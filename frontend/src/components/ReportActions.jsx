export function ReportActions({ children, onExport, disabled = false }) {
  return <div className="report-actions">{children}<button className="secondary-button" type="button" disabled={disabled} onClick={onExport}>Export CSV</button></div>;
}
