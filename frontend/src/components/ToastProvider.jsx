import { useCallback, useMemo, useState } from 'react';
import { ToastContext } from './toast-context.js';

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const notify = useCallback(({ title, message = '', tone = 'info' }) => {
    const id = globalThis.crypto.randomUUID();
    setToasts((current) => [...current, { id, title, message, tone }]);
    globalThis.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 4000);
  }, []);

  const value = useMemo(() => ({ notify }), [notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-region" aria-label="Notifications">
        {toasts.map((toast) => (
          <div
            className={`toast toast-${toast.tone}`}
            key={toast.id}
            role={toast.tone === 'error' ? 'alert' : 'status'}
          >
            <strong>{toast.title}</strong>
            {toast.message && <span>{toast.message}</span>}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
