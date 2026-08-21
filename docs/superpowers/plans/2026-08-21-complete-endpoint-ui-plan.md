# Complete Endpoint UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every Ledgerline business endpoint a complete frontend interaction.

**Architecture:** Extend the existing modular React application with one administration workspace, one journal workspace, and focused correction/detail pages. Reuse the shared API client, TanStack Query, Money, AsyncState, Toast, and current CSS tokens.

**Tech Stack:** React 19, React Router 7, TanStack Query 5, Zod 4, MSW 2, Vitest 4, Express 5.

**Spec:** `docs/superpowers/specs/2026-08-21-complete-endpoint-ui-design.md`

## Global Constraints

- Do not add frontend dependencies.
- Do not commit or push.
- Preserve decimal strings and the shared `Money` component.
- Backend permission checks remain authoritative.
- Every new interaction has loading, error, permission, and mutation feedback.
- Every new behavior follows a failing-test-first cycle.

---

### Task 1: Role discovery contract

**Files:**
- Modify: `backend/src/routes/masters.js`
- Modify: `backend/src/routes/permissions.test.js`

**Interfaces:**
- Produces: `GET /api/v1/roles -> Array<{ id: string, name: string }>`

- [ ] Add a failing permission test that an Owner receives roles and a Viewer receives 403.
- [ ] Run the focused test and confirm the route is missing.
- [ ] Add the minimal authenticated, tenant-resolved, `org.manage`-authorized route.
- [ ] Run the focused test and backend lint.

### Task 2: Organization onboarding and Settings

**Files:**
- Create: `frontend/src/components/OrganizationCreator.jsx`
- Create: `frontend/src/pages/SettingsPage.jsx`
- Create: `frontend/src/pages/settings-page.test.jsx`
- Modify: `frontend/src/components/AppShell.jsx`
- Modify: `frontend/src/App.jsx`
- Modify: `frontend/src/index.css`

**Interfaces:**
- Consumes: `/orgs`, `/orgs/:id/members`, `/roles`, `/accounts`, `/fiscal-years`, `/periods`, `/bank-accounts`.
- Produces: first-run onboarding and permission-aware administration forms.

- [ ] Add failing tests for first-organization creation, member creation, account creation, period toggle, and bank-account creation.
- [ ] Run the focused file and confirm missing components/actions.
- [ ] Implement the reusable organization form and Settings sections with controlled forms.
- [ ] Connect invalidation, selection, toasts, and active fiscal-year label.
- [ ] Run the focused test until green.

### Task 3: Journal workspace

**Files:**
- Create: `frontend/src/pages/JournalEntriesPage.jsx`
- Create: `frontend/src/pages/journal-entries-page.test.jsx`
- Modify: `frontend/src/App.jsx`
- Modify: `frontend/src/components/AppShell.jsx`
- Modify: `frontend/src/index.css`

**Interfaces:**
- Consumes: `GET/POST /journal-entries`, `GET /journal-entries/:id`, and `POST /journal-entries/:id/reverse`.

- [ ] Add failing tests for posting a manual balanced journal and reversing a selected entry.
- [ ] Run the focused file and confirm the page is absent.
- [ ] Implement list, selected detail, controlled dynamic lines, balance display, and reversal form.
- [ ] Invalidate journals and financial report queries after mutations.
- [ ] Run the focused test until green.

### Task 4: Credit notes and receipt detail

**Files:**
- Create: `frontend/src/pages/CreditNotePage.jsx`
- Create: `frontend/src/pages/CreditNoteDetailPage.jsx`
- Create: `frontend/src/pages/ReceiptDetailPage.jsx`
- Create: `frontend/src/pages/corrections-and-receipts.test.jsx`
- Modify: `frontend/src/pages/InvoiceDetailPage.jsx`
- Modify: `frontend/src/pages/ReceiptPage.jsx`
- Modify: `frontend/src/App.jsx`
- Modify: `frontend/src/index.css`

**Interfaces:**
- Consumes: `POST /credit-notes`, `GET /credit-notes/:id`, and `GET /receipts/:id`.

- [ ] Add failing tests for issuing a credit note, rendering credit-note detail, and rendering receipt allocations.
- [ ] Run the focused file and confirm the routes/components are absent.
- [ ] Implement credit-note quantity adjustment and posting.
- [ ] Implement permanent credit-note and receipt views with linked journal entries.
- [ ] Add navigation from invoice and receipt success states.
- [ ] Run the focused test until green.

### Task 5: Mock coverage and complete verification

**Files:**
- Modify: `frontend/src/mocks/handlers.js`
- Modify: relevant frontend test fixtures only when they need complete real response shapes.

**Interfaces:**
- Produces: mock handlers for every frontend-consumed endpoint.

- [ ] Add missing mock handlers for all new interactions.
- [ ] Run all frontend tests and fix behavioral regressions.
- [ ] Run frontend lint and production build.
- [ ] Run backend lint and the focused role-route test.
- [ ] Inspect the final diff and confirm all 50 business endpoints have frontend consumers.
