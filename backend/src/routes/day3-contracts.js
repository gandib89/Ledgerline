export function serializeTaxCode(taxCode) {
  return {
    id: taxCode.id,
    code: taxCode.code,
    name: taxCode.name,
    rate: taxCode.rate.toFixed(4),
    type: taxCode.type,
    isActive: taxCode.isActive,
  };
}

export function serializeOrganizationMembership(membership) {
  const { organization, role } = membership;
  return {
    id: organization.id,
    name: organization.name,
    isActive: organization.isActive,
    createdAt: organization.createdAt,
    role: { id: role.id, name: role.name },
    permissions: role.rolePermissions
      .map(({ permission }) => permission.code)
      .sort(),
  };
}

export function buildInvoiceDateFilter({ from, to }) {
  if (!from && !to) return {};
  return {
    docDate: {
      ...(from ? { gte: new Date(`${from}T00:00:00.000Z`) } : {}),
      ...(to ? { lte: new Date(`${to}T00:00:00.000Z`) } : {}),
    },
  };
}
