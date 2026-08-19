# Day 6 Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Day 6 Developer B audit, polish, mobile reconciliation, and exact demo-seed deliverables.

**Architecture:** Add one tenant-scoped audit read service/route, one React audit page, a narrow responsive tab enhancement in Banking, and deterministic demo-data helpers consumed by the existing Prisma seed. Reuse existing auth, RBAC, API-client, Query, CSS, and posting-service boundaries.

**Tech Stack:** Express 5, Prisma 7, Zod 4, React 19, React Router 7, TanStack Query 5, Vitest 4, Testing Library, native CSS.

## Global Constraints

- Follow `ledgerline-7-day-plan_1.md` Day 6 Developer B exactly.
- Preserve the approved cream, emerald, ink, and sidebar design system.
- Add no frontend dependency.
- Never render raw HTML from audit JSON.
- Scope every audit read by `organizationId` and require `audit.view`.
- Keep money as decimal strings and render it through `<Money>`.
- Keep current uncommitted Day 4-5 changes intact.
- Make no commit or push.

---

### Task 1: Tenant-scoped audit read contract

**Files:**
- Create: `backend/src/lib/audit/audit-query.js`
- Create: `backend/src/lib/audit/audit-query.test.js`
- Create: `backend/src/routes/audit.js`
- Create: `backend/src/routes/audit.test.js`
- Modify: `backend/src/app.js`

**Interfaces:**
- Produces: `listAuditEntries(db, organizationId, filters)` returning serialized entries and pagination metadata.
- Produces: `GET /api/v1/audit-log?entityType=&entityId=&actorId=&page=`.

- [x] Write a failing database-independent service test using a fake Prisma boundary.
- [x] Run the test and confirm the missing module failure.
- [x] Implement strict filter construction, newest-first pagination, actor lookup, and serialization.
- [x] Re-run the service test and confirm it passes.
- [x] Add a database integration route test for permission and tenant isolation.
- [x] Mount the authenticated, tenant-resolved, `audit.view`-guarded route.

### Task 2: Audit timeline frontend

**Files:**
- Create: `frontend/src/lib/audit-diff.js`
- Create: `frontend/src/lib/audit-diff.test.js`
- Create: `frontend/src/pages/AuditTrailPage.jsx`
- Create: `frontend/src/pages/day6-audit.test.jsx`
- Modify: `frontend/src/App.jsx`
- Modify: `frontend/src/components/AppShell.jsx`
- Modify: `frontend/src/mocks/handlers.js`

**Interfaces:**
- Consumes: `GET /audit-log` and active-organization permissions.
- Produces: `/audit` route with filters, expandable details, diff rows, and pagination.

- [x] Write failing diff-helper tests for added, removed, and changed fields.
- [x] Run the helper tests and confirm the missing module failure.
- [x] Implement deterministic top-level JSON diffing and display conversion.
- [x] Write a failing page test for filters, actor/IP/request metadata, and expansion.
- [x] Run it and confirm the page is missing.
- [x] Implement the page, route, real navigation link, stateful mock response, and permission state.
- [x] Re-run focused tests.

### Task 3: Accessible mobile reconciliation tabs

**Files:**
- Modify: `frontend/src/pages/BankingPage.jsx`
- Modify: `frontend/src/pages/day5-banking.test.jsx`
- Modify: `frontend/src/index.css`

**Interfaces:**
- Produces: `role="tablist"`, Statement and Ledger tabs, and linked `tabpanel` elements below the mobile breakpoint.

- [x] Add a failing banking test for tab roles, selection, and panel visibility.
- [x] Run it and confirm the tab controls are absent.
- [x] Add controlled workspace selection with proper ARIA relationships.
- [x] Add CSS that hides the tab control on desktop and presents one active panel below 768px.
- [x] Re-run banking tests.

### Task 4: Cross-app accessibility and financial polish

**Files:**
- Modify: `frontend/src/components/AsyncState.jsx`
- Modify: `frontend/src/components/AsyncState.test.jsx`
- Modify: `frontend/src/index.css`
- Review: all frontend pages and components.

**Interfaces:**
- Produces: distinct loading/status and error/alert semantics without changing existing callers unnecessarily.

- [x] Write a failing AsyncState test for error announcement semantics.
- [x] Add a `tone` prop that selects `status` or `alert` and update error call sites.
- [x] Audit interactive accessible names, 44px targets, numeric alignment, negative formatting, overflow, empty states, and reduced motion.
- [x] Run focused accessibility and money tests.

### Task 5: Exact idempotent Section 14 demo dataset

**Files:**
- Create: `backend/prisma/demo-data.js`
- Create: `backend/prisma/demo-data.test.js`
- Modify: `backend/prisma/seed.js`

**Interfaces:**
- Produces: `DEMO_SCENARIO` with fixed dates, amounts, references, and stable IDs.
- Produces: `seedDemoScenario(prisma, context)` invoked by the existing seed after masters.

- [x] Write a failing unit test for the exact opening balance, invoice, receipt, rent, bank-statement, service-charge, and closing-balance values.
- [x] Run it and confirm the module is missing.
- [x] Implement the immutable scenario specification and validation helpers.
- [x] Implement idempotent persistence using existing accounting services or stable-key upserts.
- [x] Re-run the unit test.
- [ ] Run the real seed twice when PostgreSQL and the required environment variables are available.

### Task 6: Documentation and verification

**Files:**
- Create: `Docs_Ledgerline/frontend/day-6-audit-polish-and-demo-data.md`
- Review: all changed Day 6 files.

**Interfaces:**
- Produces: an evidence-backed, uncommitted Day 6 frontend delivery.

- [x] Document what works, why it exists, files, controls, and test limitations.
- [x] Run frontend lint, full tests, and build.
- [x] Run backend lint and database-independent tests.
- [ ] Run database-backed audit tests and seed twice only when PostgreSQL is available.
- [x] Run `git diff --check` and `git status --short`.
- [x] Compare the result line-by-line with the Day 6 Developer B list and report any environmental verification limitation.
