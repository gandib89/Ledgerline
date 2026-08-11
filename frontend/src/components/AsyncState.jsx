export function AsyncState({ title, message, action }) {
  return (
    <div className="async-state" role="status">
      <span className="async-state-mark" aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        {message && <p>{message}</p>}
      </div>
      {action}
    </div>
  );
}
