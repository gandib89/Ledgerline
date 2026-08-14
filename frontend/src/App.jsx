import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell.jsx';
import { ProtectedRoute } from './components/ProtectedRoute.jsx';
import { AccountsPage } from './pages/AccountsPage.jsx';
import { CustomersPage } from './pages/CustomersPage.jsx';
import { DashboardPage } from './pages/DashboardPage.jsx';
import { LoginPage } from './pages/LoginPage.jsx';
import { RegisterPage } from './pages/RegisterPage.jsx';
import { InvoiceDetailPage } from './pages/InvoiceDetailPage.jsx';
import { InvoiceEditorPage } from './pages/InvoiceEditorPage.jsx';
import { InvoicesPage } from './pages/InvoicesPage.jsx';
import { TrialBalancePage } from './pages/TrialBalancePage.jsx';

function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route element={<ProtectedRoute />}>
        <Route element={<AppShell />}>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/accounts" element={<AccountsPage />} />
          <Route path="/customers" element={<CustomersPage />} />
          <Route path="/invoices" element={<InvoicesPage />} />
          <Route path="/invoices/new" element={<InvoiceEditorPage />} />
          <Route path="/invoices/:id/edit" element={<InvoiceEditorPage />} />
          <Route path="/invoices/:id" element={<InvoiceDetailPage />} />
          <Route path="/reports/trial-balance" element={<TrialBalancePage />} />
        </Route>
      </Route>
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}

export default App;
