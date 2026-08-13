import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { AuthProvider } from './auth/AuthContext.jsx';
import { ToastProvider } from './components/ToastProvider.jsx';
import { createAppQueryClient } from './query-client.js';
import './index.css';

// Day 2 wires the app to the real API. Mocks stay available behind a flag
// (VITE_USE_MOCKS=true) for working on screens while the backend is down.
async function enableMocking() {
  if (!import.meta.env.DEV || import.meta.env.VITE_USE_MOCKS !== 'true') return;
  const { worker } = await import('./mocks/browser.js');
  await worker.start({ onUnhandledRequest: 'bypass' });
}

function renderApp() {
  const queryClient = createAppQueryClient();
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <ToastProvider>
            <AuthProvider>
              <App />
            </AuthProvider>
          </ToastProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
}

enableMocking().then(renderApp);
