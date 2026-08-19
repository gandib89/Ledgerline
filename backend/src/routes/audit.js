import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { listAuditEntries } from '../lib/audit/audit-query.js';
import { authenticate } from '../middleware/authenticate.js';
import { authorize } from '../middleware/authorize.js';
import { resolveTenant } from '../middleware/resolve-tenant.js';

const router = Router();
router.use(authenticate, resolveTenant);

const auditQuerySchema = z.object({
  entityType: z.string().trim().min(1).max(100).optional(),
  entityId: z.string().trim().min(1).max(200).optional(),
  actorId: z.string().uuid().optional(),
  page: z.coerce.number().int().positive().default(1),
}).strict();

router.get('/audit-log', authorize('audit.view'), async (req, res, next) => {
  try {
    const query = auditQuerySchema.parse(req.query);
    res.json(await listAuditEntries(prisma, req.organizationId, query));
  } catch (error) {
    next(error);
  }
});

export default router;
