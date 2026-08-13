import { z } from 'zod';
import { prisma } from '../db/client.js';
import { requestContext } from '../lib/request-context.js';

const orgIdSchema = z.string().uuid();

// Factory so tenancy can come from the header (most routes) or a path param
// (/orgs/:id/members, where the contract has no X-Organization-Id header).
export function resolveTenantFrom(getOrgId) {
  return async (req, res, next) => {
    const parsed = orgIdSchema.safeParse(getOrgId(req));
    if (!parsed.success) {
      const err = new Error('Organization id missing or malformed');
      err.status = 400;
      err.code = 'org_header_invalid';
      return next(err);
    }
    const organizationId = parsed.data;

    // Runs BEFORE requestContext.run — there is no tenant context to filter by
    // yet, which is exactly why the tenant extension must leave this query alone.
    const membership = await prisma.membership.findFirst({
      where: { userId: req.userId, organizationId, isActive: true },
    });

    if (!membership) {
      const err = new Error('Not a member of this organization');
      err.status = 403;
      err.code = 'forbidden';
      return next(err);
    }

    req.organizationId = organizationId;
    req.roleId = membership.roleId;

    requestContext.run({ organizationId }, next);
  };
}

export const resolveTenant = resolveTenantFrom((req) => req.headers['x-organization-id']);
