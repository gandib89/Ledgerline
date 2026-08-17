import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { authenticate } from '../middleware/authenticate.js';
import { resolveTenant } from '../middleware/resolve-tenant.js';
import { authorize } from '../middleware/authorize.js';
import { notFound, businessRule } from '../lib/accounting/errors.js';
import { runIdempotent } from '../lib/idempotency/run-idempotent.js';
import { importStatement } from '../lib/banking/statement-import-service.js';
import { csvImportLimiter } from '../lib/rate-limit.js';
import { fileSha256 } from '../lib/banking/csv.js';
import { rejectSuggestedLine } from '../lib/banking/reject-suggestion.js';
import {
  manualMatchLine, createEntryFromLine, ignoreLine, createReconciliation, completeReconciliation,
} from '../lib/banking/reconciliation-service.js';

const router = Router();
router.use(authenticate, resolveTenant);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function actorFrom(req) {
  return { userId: req.userId, organizationId: req.organizationId, roleId: req.roleId };
}

function serializeBankAccount(b) {
  return {
    id: b.id,
    accountId: b.accountId,
    bankName: b.bankName,
    accountNoMasked: b.accountNoMasked,
    openingBalance: b.openingBalance.toFixed(2),
    isActive: b.isActive,
  };
}

function serializeStatementLine(l) {
  return {
    id: l.id,
    statementId: l.statementId,
    txnDate: l.txnDate.toISOString().slice(0, 10),
    description: l.description,
    reference: l.reference,
    debit: l.debit.toFixed(2),
    credit: l.credit.toFixed(2),
    runningBalance: l.runningBalance != null ? l.runningBalance.toFixed(2) : null,
    status: l.status.toLowerCase(),
    matchedJournalLineId: l.matchedJournalLineId,
    matchConfidence: l.matchConfidence != null ? Number(l.matchConfidence).toFixed(3) : null,
    matchedBy: l.matchedBy ? l.matchedBy.toLowerCase() : null,
    ignoreReason: l.ignoreReason,
  };
}

function serializeStatement(s, lines) {
  return {
    id: s.id,
    bankAccountId: s.bankAccountId,
    fileName: s.fileName,
    periodStart: s.periodStart.toISOString().slice(0, 10),
    periodEnd: s.periodEnd.toISOString().slice(0, 10),
    openingBalance: s.openingBalance.toFixed(2),
    closingBalance: s.closingBalance.toFixed(2),
    lineCount: s.lineCount,
    lines: lines ? lines.map(serializeStatementLine) : undefined,
  };
}

function serializeReconciliation(r) {
  return {
    id: r.id,
    bankAccountId: r.bankAccountId,
    statementId: r.statementId,
    asOfDate: r.asOfDate.toISOString().slice(0, 10),
    bookBalance: r.bookBalance.toFixed(2),
    bankBalance: r.bankBalance.toFixed(2),
    difference: r.difference.toFixed(2),
    unreconciledCount: r.unreconciledCount,
    status: r.status.toLowerCase(),
  };
}

const createBankAccountSchema = z.object({
  accountId: z.string().uuid(),
  bankName: z.string().min(1),
  accountNoMasked: z.string().min(1),
  openingBalance: z.coerce.number().default(0),
}).strict();

router.get('/bank-accounts', authorize('report.view'), async (req, res, next) => {
  try {
    const bankAccounts = await prisma.bankAccount.findMany({ orderBy: { bankName: 'asc' } });
    res.json(bankAccounts.map(serializeBankAccount));
  } catch (err) {
    next(err);
  }
});

router.post('/bank-accounts', authorize('org.manage'), async (req, res, next) => {
  try {
    const input = createBankAccountSchema.parse(req.body);
    const glAccount = await prisma.account.findFirst({ where: { id: input.accountId, organizationId: req.organizationId } });
    if (!glAccount) throw notFound('Account not found');
    if (!glAccount.isBankAccount) throw businessRule('not_a_bank_account', `Account ${glAccount.code} is not flagged as a bank account`);

    const bankAccount = await prisma.bankAccount.create({
      data: { organizationId: req.organizationId, ...input },
    });

    req.auditEntry = { action: 'bankAccount.create', entityType: 'BankAccount', entityId: bankAccount.id, before: null, after: serializeBankAccount(bankAccount) };
    res.status(201).json(serializeBankAccount(bankAccount));
  } catch (err) {
    next(err);
  }
});

const columnMappingSchema = z.object({
  dateFormat: z.enum(['YYYY-MM-DD', 'DD/MM/YYYY']),
  columns: z.object({
    date: z.string(), description: z.string(), reference: z.string().optional(), balance: z.string().optional(),
    debit: z.string().optional(), credit: z.string().optional(), amount: z.string().optional(),
  }),
}).strict();

// §7 import pipeline step 1: mimetype allowlist + a 2 MB cap, memory storage
// only — never write an uploaded file to disk in this app.
const ALLOWED_MIMETYPES = ['text/csv', 'application/vnd.ms-excel'];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (!ALLOWED_MIMETYPES.includes(file.mimetype)) {
      return cb(businessRule('unsupported_file_type', `Unsupported content type: ${file.mimetype}`));
    }
    cb(null, true);
  },
});

// multer errors (oversize, bad mimetype) surface via this callback rather
// than a thrown exception — translate them into the same tagged-error shape
// every other route's error handler expects (app.js reads err.status/code).
function uploadStatementFile(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return next(businessRule('file_too_large', 'CSV file exceeds the 2 MB limit'));
    }
    next(err);
  });
}

// POST /bank-accounts/:id/statements — multipart (§7): a "file" part plus a
// "columnMapping" JSON-string part. Idempotency-Key is optional and belt-
// and-braces on top of the file's own content-hash idempotency (RECON-2) —
// it protects the in-flight request itself (e.g. a client retry after a
// dropped response), the same reasoning as every other posting endpoint.
router.post('/bank-accounts/:id/statements', authorize('bank.reconcile'), csvImportLimiter, uploadStatementFile, async (req, res, next) => {
  try {
    const bankAccountId = z.string().uuid().parse(req.params.id);
    if (!req.file) throw businessRule('missing_file', 'A CSV file is required (multipart field "file")');

    let columnMappingRaw;
    try {
      columnMappingRaw = JSON.parse(req.body.columnMapping ?? '');
    } catch {
      throw businessRule('invalid_column_mapping', 'columnMapping must be a JSON-encoded string field');
    }
    const columnMapping = columnMappingSchema.parse(columnMappingRaw);

    const actor = actorFrom(req);
    const fileName = req.file.originalname;
    const csvContent = req.file.buffer.toString('utf8');
    const key = req.headers['idempotency-key'];

    const respond = (result) => ({
      statement: serializeStatement(result.statement),
      imported: result.imported,
      autoMatched: result.autoMatched,
      suggested: result.suggested,
      unmatched: result.unmatched,
    });

    let body;
    let replayed = false;
    if (key) {
      const outcome = await runIdempotent(
        { key, endpoint: 'POST /bank-accounts/:id/statements', requestBody: { bankAccountId, fileName, fileSha256: fileSha256(csvContent), columnMapping } },
        async (tx) => {
          const result = await importStatement(actor, { bankAccountId, fileName, csvContent, columnMapping }, tx);
          return { status: 200, body: respond(result) };
        }
      );
      replayed = outcome.replayed;
      body = outcome.body;
      if (!outcome.replayed) {
        req.auditEntry = { action: 'statement.imported', entityType: 'BankStatement', entityId: body.statement.id, before: null, after: { fileName, imported: body.imported, autoMatched: body.autoMatched } };
      }
    } else {
      const result = await importStatement(actor, { bankAccountId, fileName, csvContent, columnMapping });
      body = respond(result);
      if (!result.replayed) {
        req.auditEntry = { action: 'statement.imported', entityType: 'BankStatement', entityId: body.statement.id, before: null, after: { fileName, imported: body.imported, autoMatched: body.autoMatched } };
      }
    }

    if (replayed) res.set('Idempotent-Replay', 'true');
    res.status(200).json(body);
  } catch (err) {
    next(err);
  }
});

router.get('/statements/:id/lines', authorize('report.view'), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const statement = await prisma.bankStatement.findFirst({ where: { id, organizationId: req.organizationId } });
    if (!statement) throw notFound('Statement not found');

    const lines = await prisma.bankStatementLine.findMany({ where: { statementId: id }, orderBy: { txnDate: 'asc' } });
    res.json(serializeStatement(statement, lines));
  } catch (err) {
    next(err);
  }
});

const matchLineSchema = z.object({ journalLineId: z.string().uuid() }).strict();

router.post('/lines/:id/match', authorize('bank.reconcile'), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const { journalLineId } = matchLineSchema.parse(req.body);
    const actor = actorFrom(req);

    const line = await manualMatchLine(actor, id, journalLineId);

    req.auditEntry = { action: 'statementLine.matched', entityType: 'BankStatementLine', entityId: line.id, before: null, after: { matchedJournalLineId: journalLineId, matchedBy: 'manual' } };
    res.json(serializeStatementLine(line));
  } catch (err) {
    next(err);
  }
});

router.post('/lines/:id/reject', authorize('bank.reconcile'), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const line = await rejectSuggestedLine(prisma, req.organizationId, id);

    req.auditEntry = {
      action: 'statementLine.suggestionRejected',
      entityType: 'BankStatementLine',
      entityId: line.id,
      before: { status: 'suggested' },
      after: { status: 'unmatched' },
    };
    res.json(serializeStatementLine(line));
  } catch (err) {
    next(err);
  }
});

const createEntrySchema = z.object({ accountId: z.string().uuid(), narration: z.string().optional() }).strict();

router.post('/lines/:id/create-entry', authorize('bank.reconcile'), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const input = createEntrySchema.parse(req.body);
    const actor = actorFrom(req);

    const { statementLine, journalEntry } = await createEntryFromLine(actor, id, input);

    req.auditEntry = { action: 'statementLine.createEntry', entityType: 'BankStatementLine', entityId: statementLine.id, before: null, after: { journalEntryId: journalEntry.id } };
    res.status(201).json({ statementLine: serializeStatementLine(statementLine), journalEntryId: journalEntry.id });
  } catch (err) {
    next(err);
  }
});

const ignoreLineSchema = z.object({ reason: z.string().min(1) }).strict();

router.post('/lines/:id/ignore', authorize('bank.reconcile'), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const { reason } = ignoreLineSchema.parse(req.body);
    const actor = actorFrom(req);

    const line = await ignoreLine(actor, id, reason);

    req.auditEntry = { action: 'statementLine.ignored', entityType: 'BankStatementLine', entityId: line.id, before: null, after: { reason } };
    res.json(serializeStatementLine(line));
  } catch (err) {
    next(err);
  }
});

const createReconciliationSchema = z.object({
  bankAccountId: z.string().uuid(), statementId: z.string().uuid(), asOfDate: z.string().regex(DATE_RE),
}).strict();

router.post('/reconciliations', authorize('bank.reconcile'), async (req, res, next) => {
  try {
    const input = createReconciliationSchema.parse(req.body);
    const actor = actorFrom(req);

    const reconciliation = await createReconciliation(actor, input);

    req.auditEntry = { action: 'reconciliation.created', entityType: 'Reconciliation', entityId: reconciliation.id, before: null, after: serializeReconciliation(reconciliation) };
    res.status(201).json(serializeReconciliation(reconciliation));
  } catch (err) {
    next(err);
  }
});

router.post('/reconciliations/:id/complete', authorize('bank.reconcile'), async (req, res, next) => {
  try {
    const id = z.string().uuid().parse(req.params.id);
    const actor = actorFrom(req);

    const reconciliation = await completeReconciliation(actor, id);

    req.auditEntry = { action: 'reconciliation.completed', entityType: 'Reconciliation', entityId: reconciliation.id, before: null, after: serializeReconciliation(reconciliation) };
    res.json(serializeReconciliation(reconciliation));
  } catch (err) {
    next(err);
  }
});

export default router;
