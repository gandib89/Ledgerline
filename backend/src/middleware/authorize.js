import { prisma } from '../db/client.js';

export function authorize(permissionCode) {
  return async (req, res, next) => {
    const rolePermission = await prisma.rolePermission.findFirst({
      where: { roleId: req.roleId, permission: { code: permissionCode } },
    });

    if (!rolePermission) {
      const err = new Error('Missing required permission');
      err.status = 403;
      err.code = 'forbidden';
      return next(err);
    }

    next();
  };
}