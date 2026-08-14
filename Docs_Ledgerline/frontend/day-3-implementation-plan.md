# LedgerLine Day 3 Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the Day 3 invoice lifecycle, generated-journal view, Trial Balance, supporting API contracts, and separated beginner documentation.

**Architecture:** Express and Prisma remain the source of accounting truth. React pages use the existing API client and TanStack Query with organization-scoped query keys; Zod handles immediate form feedback, while invoice totals and ledger results always come from the backend.

**Tech Stack:** Express 5, Prisma 7, PostgreSQL, Zod 4, React 19, React Router 7, TanStack Query 5, Vitest, Testing Library, MSW, and existing CSS.

## Global Constraints

- Keep NPR money values as decimal strings at API and UI boundaries.
- Use the existing premium warm-white and emerald LedgerLine visual language.
- Add no new runtime or development dependency.
- Preserve backend tenant isolation and authorization as the security boundary.
- Include organization IDs in organization-specific frontend query keys.
- Do not implement manual journals, receipts, credit notes, reversals, or later-day reports.
- Do not create a Git commit or push any branch.

---

### Task 1: Browser-supporting backend contracts

**Files:**
- Modify: `backend/src/routes/masters.js`
- Modify: `backend/src/routes/orgs.js`
- Modify: `backend/src/routes/invoices.js`
- Modify: `backend/prisma/seed.js`
- Modify: `docs/openapi.yaml`
- Test: `backend/src/routes/invoices.test.js`
- Test: `backend/src/routes/permissions.test.js`

**Interfaces:**
- Produces: `GET /api/v1/tax-codes -> TaxCode[]` with `rate` as a string.
- Produces: `GET /api/v1/orgs -> OrganizationMembership[]` with `role` and `permissions`.
- Produces: `GET /api/v1/invoices?from=YYYY-MM-DD&to=YYYY-MM-DD` filtering `docDate` inclusively.

- [x] **Step 1: Write failing API tests**

```js
expect(taxCodes.body[0]).toMatchObject({ code: 'VAT13', rate: '0.1300', type: 'VAT' });
expect(orgs.body[0]).toMatchObject({ role: { name: 'Owner' } });
expect(orgs.body[0].permissions).toContain('invoice.post');
expect(filtered.body.map((invoice) => invoice.docDate)).toEqual(['2025-07-25']);
```

- [x] **Step 2: Run focused backend tests and confirm contract failures**

Run: `npm test -- src/routes/invoices.test.js src/routes/permissions.test.js`

Expected: the new assertions fail because tax codes, membership permissions, and invoice date filters are not exposed yet.

- [x] **Step 3: Implement the smallest tenant-safe route changes**

```js
where: {
  docType: 'INVOICE',
  ...(from || to ? { docDate: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } } : {}),
}
```

Serialize `TaxCode.rate` with `toFixed(4)`, load permissions through the membership role, and seed `VAT13` against account `2200` for each demo organization.

- [x] **Step 4: Run focused tests and backend lint**

Run: `npm test -- src/routes/invoices.test.js src/routes/permissions.test.js`

Run: `npm run lint`

Expected: focused tests pass when PostgreSQL test configuration is present; lint passes independently.

### Task 2: Shared Day 3 frontend helpers and routes

**Files:**
- Modify: `frontend/src/App.jsx`
- Modify: `frontend/src/components/AppShell.jsx`
- Create: `frontend/src/pages/invoice-form.js`
- Test: `frontend/src/pages/invoice-form.test.js`
- Test: `frontend/src/App.test.jsx`

**Interfaces:**
- Produces: routes `/invoices`, `/invoices/new`, `/invoices/:id/edit`, `/invoices/:id`, and `/reports/trial-balance`.
- Produces: `invoiceFormSchema`, `invoiceInput(form)`, and `emptyInvoiceLine()`.

- [x] **Step 1: Write failing helper and route tests**

```js
expect(invoiceFormSchema.safeParse(validInvoiceForm).success).toBe(true);
expect(invoiceFormSchema.safeParse({ ...validInvoiceForm, dueDate: '2025-07-01' }).success).toBe(false);
expect(screen.getByRole('link', { name: 'Invoices' })).toHaveAttribute('href', '/invoices');
```

- [x] **Step 2: Run the focused frontend tests and confirm missing exports/routes fail**

Run: `npm test -- src/pages/invoice-form.test.js src/App.test.jsx`

- [x] **Step 3: Implement Zod validation, payload shaping, routes, and navigation links**

The payload contains only party, dates, reference, notes, and line inputs. It must not contain subtotal, VAT, grand total, outstanding amount, or journal data.

- [x] **Step 4: Run the focused tests until green**

Run: `npm test -- src/pages/invoice-form.test.js src/App.test.jsx`

### Task 3: Invoice list

**Files:**
- Create: `frontend/src/pages/InvoicesPage.jsx`
- Create: `frontend/src/pages/invoice-pages.test.jsx`
- Modify: `frontend/src/index.css`

**Interfaces:**
- Consumes: `/invoices`, `/parties`, `Money`, `AsyncState`, and organization outlet context.
- Produces: customer/status/date filters, status text, outstanding NPR amounts, pagination, and links to invoice detail/create.

- [x] **Step 1: Write a failing MSW integration test**

```jsx
expect(await screen.findByText('INV-2082-0001')).toBeInTheDocument();
expect(screen.getByText('Himalayan Trek Supplies')).toBeInTheDocument();
expect(screen.getByLabelText('Invoice status')).toHaveValue('posted');
```

- [x] **Step 2: Run the invoice-page test and confirm the page is missing**

Run: `npm test -- src/pages/invoice-pages.test.jsx`

- [x] **Step 3: Implement the list using URL-safe query construction and existing table styles**

Use `URLSearchParams` and reset the page to 1 when a filter changes. Wrap the table for narrow screens and include status as visible text.

- [x] **Step 4: Run the invoice-page test until green**

Run: `npm test -- src/pages/invoice-pages.test.jsx`

### Task 4: Invoice draft editor and server preview

**Files:**
- Create: `frontend/src/pages/InvoiceEditorPage.jsx`
- Modify: `frontend/src/pages/invoice-pages.test.jsx`
- Modify: `frontend/src/index.css`

**Interfaces:**
- Consumes: `/parties`, `/accounts?type=REVENUE`, `/tax-codes`, `/invoices/preview`, and optional `/invoices/:id`.
- Produces: create and edit payloads, including `version` only for edits.

- [x] **Step 1: Write failing tests for validation, preview, creation, and version conflicts**

```js
expect(screen.getByText('Customer is required')).toBeInTheDocument();
expect(await screen.findByText('NPR 113,000.00')).toBeInTheDocument();
expect(sentBody).not.toHaveProperty('grandTotal');
expect(screen.getByText('This invoice changed in another session.')).toBeInTheDocument();
```

- [x] **Step 2: Run focused tests and confirm the editor behavior is absent**

Run: `npm test -- src/pages/invoice-pages.test.jsx`

- [x] **Step 3: Implement dynamic lines, field errors, debounced preview, create/edit mutations, and conflict reload**

Keep one line minimum. Use native date and number inputs, visible labels, descriptive remove-button labels, and server totals only.

- [x] **Step 4: Run focused tests until green**

Run: `npm test -- src/pages/invoice-pages.test.jsx`

### Task 5: Invoice detail, permission-gated posting, and journal

**Files:**
- Create: `frontend/src/pages/InvoiceDetailPage.jsx`
- Modify: `frontend/src/pages/invoice-pages.test.jsx`
- Modify: `frontend/src/index.css`

**Interfaces:**
- Consumes: active organization `permissions`, `/invoices/:id`, `/journal-entries/:id`, and `/invoices/:id/post`.
- Produces: document/journal split, confirmation dialog, posted state, totals, and textual balance status.

- [x] **Step 1: Write failing tests for hidden and visible Post actions and confirmed posting**

```jsx
expect(screen.queryByRole('button', { name: 'Post invoice' })).not.toBeInTheDocument();
expect(screen.getByRole('button', { name: 'Post invoice' })).toBeInTheDocument();
expect(await screen.findByText('Debits equal credits')).toBeInTheDocument();
```

- [x] **Step 2: Run focused tests and confirm the detail behavior is absent**

Run: `npm test -- src/pages/invoice-pages.test.jsx`

- [x] **Step 3: Implement detail, dialog, mutation, cache updates, and journal table**

The dialog states that posting creates a permanent journal entry. Disable confirmation during the request, preserve error context, and treat backend authorization as authoritative.

- [x] **Step 4: Run focused tests until green**

Run: `npm test -- src/pages/invoice-pages.test.jsx`

### Task 6: Trial Balance

**Files:**
- Create: `frontend/src/pages/TrialBalancePage.jsx`
- Create: `frontend/src/pages/trial-balance-page.test.jsx`
- Modify: `frontend/src/index.css`

**Interfaces:**
- Consumes: `/reports/trial-balance?from=YYYY-MM-DD&asOf=YYYY-MM-DD`.
- Produces: date filters, debit/credit rows and totals, zero-difference integrity result, and empty/error/loading states.

- [x] **Step 1: Write a failing integrity-rendering test**

```jsx
expect(await screen.findByText('Trial Balance')).toBeInTheDocument();
expect(screen.getByText('Balanced — zero difference')).toBeInTheDocument();
expect(screen.getByText('Sales Revenue')).toBeInTheDocument();
```

- [x] **Step 2: Run the focused test and confirm the page is missing**

Run: `npm test -- src/pages/trial-balance-page.test.jsx`

- [x] **Step 3: Implement organization-scoped query, report table, totals, and integrity banner**

Use text and iconography in addition to color, tabular/right-aligned money, and a responsive table wrapper.

- [x] **Step 4: Run the focused test until green**

Run: `npm test -- src/pages/trial-balance-page.test.jsx`

### Task 7: Mock demo data and beginner documentation

**Files:**
- Modify: `frontend/src/mocks/handlers.js`
- Move: `Docs_Ledgerline/day-1-schema-and-triggers.md` to `Docs_Ledgerline/backend/day-1-schema-and-triggers.md`
- Move: `Docs_Ledgerline/day-2-auth-tenancy-and-rbac.md` to `Docs_Ledgerline/backend/day-2-auth-tenancy-and-rbac.md`
- Move: `Docs_Ledgerline/day-3-ledger-posting-and-invoices-explained.md` to `Docs_Ledgerline/backend/day-3-ledger-posting-and-invoices-explained.md`
- Move: `Docs_Ledgerline/openapi-contract.md` to `Docs_Ledgerline/backend/openapi-contract.md`
- Create: `Docs_Ledgerline/frontend/day-1-frontend-foundation.md`
- Create: `Docs_Ledgerline/frontend/day-2-auth-and-master-data.md`
- Modify: `Docs_Ledgerline/frontend/day-3-invoices-ledger-and-trial-balance.md`

**Interfaces:**
- Produces: a browser-demo invoice lifecycle with realistic NPR/VAT data.
- Produces: separate beginner-readable Day 1–3 backend and frontend documentation.

- [x] **Step 1: Add complete MSW contract fixtures for organizations, parties, accounts, tax codes, invoices, preview, posting, journals, and Trial Balance**

Mock response shapes must match the backend contract, including decimal strings, role, permissions, document version, and journal lines.

- [x] **Step 2: Move backend explanations and write frontend explanations**

Each frontend document explains what exists, why it exists, file responsibilities, browser-to-API flow, security/accounting decisions, test commands, and the next-day boundary in beginner-friendly language.

- [x] **Step 3: Confirm documentation links and mock-mode flows are internally consistent**

Run: `rg --files Docs_Ledgerline`

Expected: the teaching prompt remains at the root and Day 1–3 explanations are separated under `backend/` and `frontend/`.

### Task 8: Final verification

**Files:**
- Verify all changed files.

**Interfaces:**
- Produces: evidence that the delivered workspace is lint-clean, testable, buildable, and uncommitted.

- [x] **Step 1: Run frontend checks**

Run: `npm run lint`

Run: `npm test`

Run: `npm run build`

- [x] **Step 2: Run backend checks**

Run: `npm run lint`

Run database-independent test files when no safe test `DATABASE_URL` is available; run the full suite only against a dedicated test database.

- [x] **Step 3: Run repository checks**

Run: `git -c safe.directory='C:/Python Practice/Ledgerline' diff --check`

Run: `git -c safe.directory='C:/Python Practice/Ledgerline' status --short`

Expected: no whitespace errors, all requested files visible as local changes, and no commit or push performed.
