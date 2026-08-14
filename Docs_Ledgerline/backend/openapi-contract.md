# Why `docs/openapi.yaml` Exists

A from-zero explanation of OpenAPI: the problem it solves, and exactly how this project's real
contract file (`docs/openapi.yaml`) solves it. Every example below is the actual code we wrote
today, not a hypothetical.

---

## 1. The problem, without OpenAPI

Imagine building Ledgerline with no contract file. You start writing the backend's invoice endpoint
and the frontend's invoice screen at the same time (or, since you're solo, on different days). There
is nothing written down except what's in your head. A few things go wrong, silently:

- The backend returns `{ total: "100.00" }`. The frontend, written a day earlier, expects
  `{ grandTotal: "100.00" }`. Nobody notices until the screen shows a blank total in the browser.
- The backend returns `400` for a validation failure. The frontend's error handler only checks for
  `422`, because that's what you happened to type that day. The error toast never appears — the user
  just sees nothing happen.
- Three months from now, someone (possibly you) asks "does `POST /invoices` require a `dueDate`?" and
  the only way to answer is to go read the route handler's validation code, function by function.

None of these are bugs in the traditional sense — every individual piece of code works. The failure
is that the *shape of agreement* between frontend and backend, and between today's-you and
future-you, was never written down anywhere. It lived in memory, and memory is unreliable and
un-diffable.

## 2. What OpenAPI actually is

OpenAPI is a specification format — a defined vocabulary, written in YAML or JSON — for describing
an HTTP API completely: every URL, every HTTP method on it, the exact shape of every request body
and response body, every possible error code. `docs/openapi.yaml` is Ledgerline's, written against
OpenAPI version 3.0.3 (see line 1 of the file: `openapi: 3.0.3`).

The critical property that makes this different from, say, writing the same information in a
paragraph of English in a README: **it's structured enough for tools to read it, not just humans.**
Because the shapes are declared formally, other software can:

- Generate mock API responses automatically from it (MSW, planned for the frontend).
- Generate an interactive documentation page from it (Swagger UI, Day 6: `zod-to-openapi` →
  `/api/v1/docs`).
- Validate that a real response actually matches what was promised.

A paragraph in a README can't do any of that. A formal contract can.

## 3. Why this project specifically needed it *before* writing either side

CLAUDE.md's plan calls the contract freeze "the single most important event in the week" (§11,
Day 1). Here's the concrete reasoning, in terms of this exact project:

Ledgerline is split into two independent things that both need to move fast: `backend/` (Express +
Prisma) and `frontend/` (React). If frontend work waits for backend endpoints to actually exist and
run, that's the entire week gone to serialized, not parallel, work. The fix is to let the frontend
build against **fake responses that are guaranteed to match the real ones later** — which only works
if "the real ones" were nailed down *before* anyone started guessing at either side.

That's what `docs/openapi.yaml` is. It was written before a single Express route handler or React
screen for invoices, receipts, or reports exists. Once it's committed, disagreements about shape stop
being something you discover by accident three weeks later — they become something you'd have to
deliberately go edit a shared file to introduce, which CLAUDE.md flags explicitly:

> "Rule: never edit a shared file without saying so... These three paths cause 90% of merge conflicts
> on a two-person project." (§12, on `docs/openapi.yaml` as a shared file)

## 4. Reading our actual file, section by section

### `info` and `servers` — identity, not behavior

```yaml
openapi: 3.0.3
info:
  title: Ledgerline API
  version: 1.0.0
  description: Multi-tenant double-entry accounting API.

servers:
  - url: http://localhost:3000/api/v1
```

Metadata only — no endpoints yet. `servers` is genuinely useful once tooling gets involved: Swagger
UI (Day 6) uses this URL as the base it sends real "try it out" requests to. Right now it's the
`/healthz`-adjacent local dev address; production will need a second entry once deployed (Day 7).

### `components` — the part that makes this *not* copy-paste

This is the section that does the real work of the file, and it's worth understanding why it exists
at all before looking at any specific piece of it.

Without `components`, describing 10+ endpoints in OpenAPI means repeating the same shapes over and
over: every single endpoint that can fail validation would need its own full, inline description of
what an error response looks like. `components` lets you define a shape **once** and reference it
by name everywhere it's needed — the OpenAPI equivalent of writing a function instead of repeating
the same five lines of code in ten places.

**The `Error` schema — defined once, used constantly:**

```yaml
components:
  schemas:
    Error:
      type: object
      properties:
        error:
          type: object
          properties:
            code:
              type: string
              example: VALIDATION_ERROR
            message:
              type: string
            requestId:
              type: string
          required: [code, message]
      required: [error]
```

This isn't an invented shape — it's the exact envelope written into `backend/src/index.js`'s error
handler on Day 1:

```js
res.status(err.status || 500).json({
  error: {
    code: err.code || 'INTERNAL_ERROR',
    message: err.message || 'Something went wrong',
    requestId: req.id,
  },
});
```

The contract describes the *same shape* the running code actually produces — that correspondence is
the entire point. In the current file, this one schema is referenced (via `$ref`) **5 separate
times** across `BadRequest`, `Unauthorized`, `Forbidden`, `NotFound`, and one inline use on
`/auth/refresh`'s `401`. Every one of those five spots describes an error response identically,
because they all point at the same definition. If the error envelope ever changes shape, it changes
in exactly one place — line 12 — not five.

**`components.responses` — reusable *response* shapes, one level up from schemas:**

```yaml
  responses:
    BadRequest:
      description: Validation failed
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/Error'
    Unauthorized: ...
    Forbidden: ...
    NotFound: ...
```

Where `schemas` describes the *shape of data*, `responses` describes *a whole HTTP response* (status
code's meaning + content type + body shape) built from that data. This second layer of reuse is why
every endpoint in this file can write:

```yaml
        '400':
          $ref: '#/components/responses/BadRequest'
```

— one line — instead of re-describing `content: application/json: schema: ...` every single time a
`400` is possible. Grep the real file: `#/components/responses/` appears **7 times** across the
paths we've written so far. Without this indirection, that's 7 duplicated blocks instead of 7
one-liners.

**`components.parameters` — the same idea, applied to a request header:**

```yaml
  parameters:
    OrganizationHeader:
      name: X-Organization-Id
      in: header
      required: true
      description: Which organization this request operates on. Verified server-side against an active membership.
      schema:
        type: string
        format: uuid
```

This is the contract's documentation of CLAUDE.md's central authorization mechanism (§5, line 331):
"read the `X-Organization-Id` header → look up an active membership... Never trust the header
alone." Every tenant-scoped endpoint we've written — `/accounts`, `/parties`, `/fiscal-years`,
`/periods` — references it with one line:

```yaml
      parameters:
        - $ref: '#/components/parameters/OrganizationHeader'
```

It's referenced **6 times** in the current file. If a second required header ever needs adding to
every tenant-scoped endpoint (say, an API version header), there'd be one line to change, not six —
and more importantly, all six endpoints are *guaranteed* to require the header identically, because
they're not six independent hand-typed descriptions that could quietly drift apart.

**`components.securitySchemes` — describing *how* auth works, once:**

```yaml
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
```

This says "requests authenticate via `Authorization: Bearer <token>`." Every path in this file
inherits this as its default requirement — which is exactly why the three auth endpoints that must
work *without* a token (`register`, `login`, `refresh`) each carry an explicit override:

```yaml
  /auth/login:
    post:
      security: []
```

`security: []` means "no security scheme required here" — overriding the global default for this one
operation. Documenting that override explicitly, right next to the endpoint, is itself useful
information: it tells a reader "this endpoint is intentionally public," rather than leaving them to
wonder whether it's a bug that no token is checked.

### `paths` — the actual endpoints

Everything above exists to make this section short and accurate. One real endpoint from our file,
annotated:

```yaml
paths:
  /orgs/{id}/members:
    get:
      summary: List members of an organization
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
            format: uuid
      responses:
        '200':
          description: List of members
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/Member'
        '404':
          $ref: '#/components/responses/NotFound'
```

Reading it: the URL (`/orgs/{id}/members`), the HTTP method (`get`), the path parameter it needs
(`id`, declared as a required UUID), and every response it can produce — success (`200`, an array of
`Member` objects) and one documented failure (`404`, reusing the shared shape). A frontend engineer
(or, since this is solo, you on a future day) can answer "what does this endpoint return, and how
can it fail" without reading a single line of Express code — the contract *is* the answer, and it's
the same answer the running server will actually give, because both were built to agree with it.

## 5. What this file will power later, that a README couldn't

Nothing in `docs/openapi.yaml` compiles or runs. But because it's *structured*, not prose, it's a
direct input to other tools coming later this week:

- **MSW (Mock Service Worker)**, planned for the frontend — generates fake API responses that match
  these exact schemas, so screens can be built and demoed before the real backend endpoint exists.
- **Swagger UI** (Day 6: `zod-to-openapi` → `/api/v1/docs`) — turns this file into an interactive,
  browsable, "try it out" documentation page, generated automatically, never hand-maintained
  separately from the code.
- **Zod schemas** — CLAUDE.md's plan (§12) treats `docs/openapi.yaml` and the shared Zod validation
  schemas as points that should agree; in later days, request validation in Express uses Zod schemas
  shaped to match what's promised here.

None of that is possible from a paragraph of prose describing the same endpoints. The format being
machine-readable, not just human-readable, is what unlocks all three.

## 6. One deliberate gap, for now

You'll notice every money-shaped value in the schemas so far (`FiscalYear.startDate`, etc.) is a
plain string/date — no invoice totals or journal amounts exist in the contract yet, because those
endpoints (`/invoices`, `/journal-entries`, the six reports) haven't been written into the file yet.
When they arrive, they'll need to document the same rule `money.js` and the Prisma schema already
enforce: money is always a **string**, never a JSON number, because (as `money.js`'s own comment
says) floats can't round-trip a value like `"135600.0000"` without precision loss. OpenAPI expresses
that as:

```yaml
grandTotal:
  type: string
  example: "135600.0000"
```

`type: string`, not `type: number` — a small detail, but one that would be easy to get wrong by
copying a typical "amount" field from an OpenAPI example found online. Worth remembering when those
endpoints get added.

## 7. Quick glossary

| Term | Meaning |
|---|---|
| **OpenAPI** | The specification format itself — a defined vocabulary for describing HTTP APIs, in YAML or JSON |
| **Swagger** | The older name for the same thing; "Swagger UI" is a specific tool that renders an OpenAPI file as an interactive docs page |
| **Contract** | This project's informal term for `docs/openapi.yaml` — the agreed shape both frontend and backend build against |
| **Schema** (in this context) | The description of one data shape's fields and types — e.g. `components.schemas.User` |
| **`$ref`** | A pointer to a schema/response/parameter defined elsewhere in the file, so it isn't repeated |
| **Path** | One URL pattern, e.g. `/orgs/{id}/members` |
| **Operation** | One HTTP method on one path — `get` on `/orgs` and `post` on `/orgs` are two separate operations on the same path |
| **Media type** | The content format of a request/response body — `application/json` is the only one this project uses |
| **`requestBody`** | The shape of data sent *to* an endpoint (e.g. the JSON body of a `POST`) |
| **`responses`** (lowercase, inside a path) | Every possible outcome of calling this operation, keyed by HTTP status code |
