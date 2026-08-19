export function AsyncState({ title, message, action, tone = 'status' }) {
  return (
    <div className={`async-state async-state-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <span className="async-state-mark" aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        {message && <p>{message}</p>}
      </div>
      {action}
    </div>
  );
}
