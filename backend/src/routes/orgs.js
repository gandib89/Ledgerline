import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { authenticate } from '../middleware/authenticate.js';
import { resolveTenantFrom } from '../middleware/resolve-tenant.js';
import { authorize } from '../middleware/authorize.js';
import { serializeOrganizationMembership } from './day3-contracts.js';
import { provisionStarterKit, currentFiscalYearWindow } from '../lib/orgs/starter-kit.js';

const router = Router();

const resolveTenantFromPath = resolveTenantFrom((req) => req.params.id);

function serializeOrg(org) {
  return { id: org.id, name: org.name, isActive: org.isActive, createdAt: org.createdAt };
}

function serializeMember(membership) {
  return {
    id: membership.id,
    user: { id: membership.user.id, email: membership.user.email },
    role: { id: membership.role.id, name: membership.role.name },
    isActive: membership.isActive,
  };
}

// No tenant context here: this is the endpoint that tells the client which
// organizations exist for them in the first place.
router.get('/', authenticate, async (req, res, next) => {
  try {
    const memberships = await prisma.membership.findMany({
      where: { userId: req.userId, isActive: true },
      include: {
        organization: true,
        role: { include: { rolePermissions: { include: { permission: true } } } },
      },
    });
    res.json(memberships.map(serializeOrganizationMembership));
  } catch (err) {
    next(err);
  }
});

const createOrgSchema = z.object({ name: z.string().min(1) }).strict();

router.post('/', authenticate, async (req, res, next) => {
  try {
    const { name } = createOrgSchema.parse(req.body);

    const ownerRole = await prisma.role.findUnique({ where: { name: 'Owner' } });
    if (!ownerRole) {
      const err = new Error('Owner role missing — run the seed script');
      err.status = 500;
      err.code = 'role_missing';
      throw err;
    }

    // Org + first membership must land together: an org with no owner is
    // unreachable, since every other route requires an active membership.
    const org = await prisma.$transaction(async (tx) => {
      const created = await tx.organization.create({ data: { name } });
      await tx.membership.create({
        data: { userId: req.userId, organizationId: created.id, roleId: ownerRole.id },
      });
      return created;
    });

    req.auditEntry = {
      // No tenant context on this route yet — the extension has nothing to inject.
      organizationId: org.id,
      action: 'org.create',
      entityType: 'Organization',
      entityId: org.id,
      before: null,
      after: serializeOrg(org),
    };

    res.status(201).json(serializeOrg(org));
  } catch (err) {
    next(err);
  }
});

// A brand-new organization has no fiscal year and no chart of accounts, so
// it can never post anything (plan §5: COA is seeded, not user-built). The
// onboarding UI calls this right after POST /, once, to provision the
// standard starter kit. Deliberately a separate call rather than folded
// into POST / — the test suite's makeUserWithOrg() helper creates its own
// lean fixtures per org via that route, and a starter kit landing there
// unconditionally would collide with them on account code.
router.post('/:id/starter-kit', authenticate, resolveTenantFromPath, authorize('org.manage'), async (req, res, next) => {
  try {
    // A real org starts with whichever fiscal year covers today, not the
    // plan's fixed demo anchor — see currentFiscalYearWindow().
    await prisma.$transaction((tx) => provisionStarterKit(tx, req.organizationId, currentFiscalYearWindow()));
    res.status(201).json({ provisioned: true });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/members', authenticate, resolveTenantFromPath, authorize('org.manage'), async (req, res, next) => {
  try {
    const memberships = await prisma.membership.findMany({
      include: { user: true, role: true },
    });
    res.json(memberships.map(serializeMember));
  } catch (err) {
    next(err);
  }
});

const addMemberSchema = z.object({
  email: z.string().email(),
  roleId: z.string().uuid(),
}).strict();

router.post('/:id/members', authenticate, resolveTenantFromPath, authorize('org.manage'), async (req, res, next) => {
  try {
    const { email, roleId } = addMemberSchema.parse(req.body);

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      const err = new Error('No user with that email');
      err.status = 404;
      err.code = 'user_not_found';
      throw err;
    }

    const role = await prisma.role.findUnique({ where: { id: roleId } });
    if (!role) {
      const err = new Error('Unknown role');
      err.status = 400;
      err.code = 'role_not_found';
      throw err;
    }

    // organizationId is injected by the tenant extension from request context.
    const membership = await prisma.membership.create({
      data: { userId: user.id, roleId },
      include: { user: true, role: true },
    });

    req.auditEntry = {
      action: 'member.add',
      entityType: 'Membership',
      entityId: membership.id,
      before: null,
      after: serializeMember(membership),
    };

    res.status(201).json(serializeMember(membership));
  } catch (err) {
    next(err);
  }
});

export default router;
