import { writeAuditLog } from '../lib/audit/audit-log.js';
import { safeErrorLog } from '../lib/log-redact.js';

export function auditLog(req, res, next) {
  res.on('finish', () => {
    if (!req.auditEntry) return;
    if (res.statusCode < 200 || res.statusCode >= 300) return;

    writeAuditLog({
      ...req.auditEntry,
      userId: req.userId,
      requestId: req.id,
      ipAddress: req.ip,
    }).catch((err) => {
      console.error(`[${req.id}] audit log write failed`, safeErrorLog(err));
    });
  });
  next();
}
