import { requestContext } from '../lib/request-context.js';

const TENANT_SCOPED_MODELS = new Set([
  'Membership', 'FiscalYear', 'Account', 'TaxCode',
  'JournalEntry', 'AuditLog', 'IdempotencyKey', 'Party',
  'Document', 'DocumentSeries', 'JournalLine', 'EntrySeries',
  'PaymentAllocation', 'BankAccount', 'BankStatement',
  'BankStatementLine', 'Reconciliation',
]);

const SINGLE_RECORD_READS = ['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'update', 'delete'];
const MULTI_RECORD_READS = ['findMany', 'count', 'updateMany', 'deleteMany'];

export function withTenantScope(client) {
  return client.$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const organizationId = requestContext.getStore()?.organizationId;
          if (!organizationId || !TENANT_SCOPED_MODELS.has(model)) {
            return query(args);
          }

          if (SINGLE_RECORD_READS.includes(operation) || MULTI_RECORD_READS.includes(operation)) {
            args.where = { ...args.where, organizationId };
          }

          if (operation === 'create') {
            args.data = { ...args.data, organizationId };
          }

          return query(args);
        },
      },
    },
  });
}
