I want you to create a Markdown documentation file that reproduces the same style and teaching approach as my existing `day-2-auth-tenancy-and-rbac.md`.

I am an **absolute beginner**. Assume I know nothing unless the repository clearly proves otherwise.

### Main goal

Create a detailed Markdown file that explains **everything built in the current development session** using the **actual repository as the source of truth**.

Do NOT write a generic tutorial.

The document should teach me my own project so thoroughly that, after reading it, I can explain:

- what was built
- why it was built
- how it works
- how the files connect
- what each important piece of code does
- what happens at runtime
- why the security/architecture decisions were made
- what errors happened and how they were debugged
- how this work fits into the overall development plan

### Beginner teaching rule

Explain everything from **zero level**.

Whenever you introduce a technical term, explain it before using it.

For example, do not simply say:

> "The middleware validates the JWT."

Instead explain:

1. What an HTTP request is.
2. What middleware is.
3. What a JWT is.
4. What validation means.
5. Then explain how this project's middleware validates the JWT.

Do this consistently throughout the document.

### Use the actual repository

First inspect the repository carefully.

Identify:

- files created
- files modified
- important existing files involved in the feature
- functions
- middleware
- routes
- database models
- frontend components/pages
- tests
- configuration
- environment variables
- migrations
- scripts
- dependencies

Use **exact file paths**.

Use the actual code from the repository rather than inventing simplified replacements.

When showing code, explain the real code line by line or logical section by logical section.

### Required document structure

Use a structure similar to:

# [Session/Day] — [Main Topics]

Briefly explain what this document covers and state that the repository is the source of truth.

## 1. What we built in this session

Explain what existed before the session and what exists now.

Start with the real problems the session solved.

For each problem explain:

- What was wrong before
- Why it matters
- What we built
- Why that solution was chosen

## 2. How it relates to the development plan

Identify the relevant day/phase of the project plan.

For each objective explain:

| Plan objective | What we built | Why it matters |

Also explain:

- what is completed
- what is intentionally incomplete
- why unfinished items are scheduled later
- how this work prepares the next development days

## 3. Files created and modified

Group files logically, for example:

### Authentication

- file
- purpose
- why it exists
- what calls it
- what it calls

### Middleware

...

### Database

...

### Frontend

...

### Tests

...

For every important file, explain its role in the architecture.

## 4. The code explained from zero

This is the most important section.

For every important file:

### File: `exact/path/file.js`

**Status:** Created / Modified

**Purpose:** Explain the file in one simple paragraph.

**Why does this file exist?**

**How does it connect to other files?**

Then show the real code.

After the code, teach every important concept from zero.

For example, explain syntax such as:

- `import`
- `export`
- `const`
- `let`
- objects
- arrays
- functions
- parameters
- return values
- destructuring
- spread syntax
- promises
- `async`
- `await`
- `try/catch`
- ternary operator
- optional chaining
- logical operators
- method chaining
- callbacks
- closures
- middleware
- database queries
- Prisma methods
- HTTP concepts

Only explain concepts that are actually relevant to the code.

For every important function explain:

**Data in → processing → data out → who calls it → what it calls**

Also explain why the code was written this way rather than merely describing what it does.

### Runtime explanation

After explaining a function, explain what happens when it actually runs.

Use numbered steps.

For example:

1. Browser sends request.
2. Express receives request.
3. Middleware runs.
4. Database is queried.
5. Result is returned.
6. Response is sent to browser.

Make the runtime flow extremely clear to a beginner.

## 5. Complete request/runtime flow

Trace the important flows from beginning to end.

For example:

Browser
→ frontend
→ API request
→ Express
→ middleware
→ business logic
→ Prisma
→ PostgreSQL
→ response
→ frontend

Do this for the major features implemented in the session.

Explain every component encountered in the flow.

## 6. New concepts introduced

Create a beginner-friendly glossary/teaching section.

Explain each new concept in plain English.

For example:

- Authentication
- Authorization
- JWT
- Access token
- Refresh token
- Cookie
- HttpOnly
- Middleware
- Multi-tenancy
- RBAC
- Prisma Client
- Transaction
- Hashing
- Argon2
- SHA-256
- Idempotency
- Audit log

Only include concepts actually introduced in this session.

## 7. Errors and debugging

Document the real problems encountered during the session.

For every error explain:

### Problem

What happened?

### Error message

Show the important error.

### Why it happened

Explain the root cause from beginner level.

### How we diagnosed it

Explain how we figured it out.

### Fix

Explain exactly what changed.

### Lesson

Explain what I should remember so I can debug this type of problem myself next time.

Do not hide mistakes. I want to understand them.

## 8. Final understanding check

Create questions that test whether I actually understand the implementation.

Do not create generic textbook questions.

Ask questions specifically about this project.

Group them into sections such as:

### On what we built

### On security reasoning

### On architecture

### On request lifecycle

### On debugging

### On the development plan

Questions should test **why**, not merely memorization.

Examples of the style I want:

- Why are there two different tokens instead of one?
- Why is this middleware placed before that middleware?
- Why is this value stored in the database instead of the JWT?
- What security problem would appear if this filter were removed?
- What happens to the request if this middleware fails?
- Why does this query need to be tenant-scoped?
- What would break if this transaction were removed?

### Important style rules

1. Assume I am an absolute beginner.
2. Never skip foundational concepts.
3. Prefer simple language over jargon.
4. Use real examples from LedgerLine.
5. Explain **why**, not just **what**.
6. Connect concepts together.
7. Use diagrams in plain text where useful.
8. Use exact file paths.
9. Use the real code from the repository.
10. Never invent code or behavior that does not exist.
11. Clearly distinguish:

- what the code actually does
- why the code was designed that way
- what could theoretically be done differently

12. Explain security decisions in beginner-friendly terms.
13. Explain the difference between similar concepts that beginners commonly confuse.
14. When a piece of code depends on another file, follow the dependency and explain that file too.
15. Do not assume knowledge of JavaScript, Node.js, Express, Prisma, PostgreSQL, React, HTTP, authentication, or security.

### Depth requirement

Be detailed.

Do not compress several concepts into one sentence just to make the document shorter.

The goal is not to produce the smallest documentation file.

The goal is:

> "A complete teaching document that lets an absolute beginner understand and explain what was built."

### Final verification

Before finishing:

1. Compare the documentation against the actual repository.
2. Make sure every important file is covered.
3. Make sure the code examples are accurate.
4. Make sure no feature is claimed to exist unless it actually exists.
5. Make sure the runtime flows match the real implementation.
6. Make sure the understanding-check questions are answerable from the document.
7. Include exact commit information if available.
8. State what is intentionally deferred to later days if the project has a day-by-day plan.

Save the result as a `.md` file in the repository, using a descriptive filename such as:

`day-X-[topics]-explained.md`
