import { prisma } from '../../db/client.js';
import { notFound, conflict } from './errors.js';

// Drafts have no journal entry, number or allocations, so deleting one is just
// removing the Document row (DocumentLine cascades). Anything posted stays:
// ADR 0001, corrections are reversals. Returns the deleted draft for the audit log.
export async function deleteDraftDocument(actor, documentId, docType, label) {
  return prisma.$transaction(async (tx) => {
    const doc = await tx.document.findFirst({
      where: { id: documentId, organizationId: actor.organizationId, docType },
      include: { lines: true },
    });
    if (!doc) throw notFound(`${label} not found`);
    if (doc.status !== 'DRAFT') throw conflict('not_draft', `${label} ${documentId} is not a draft`);

    const result = await tx.document.deleteMany({
      where: { id: documentId, organizationId: actor.organizationId, docType, status: 'DRAFT' },
    });
    if (result.count === 0) throw conflict('not_draft', `${label} ${documentId} is not a draft`);
    return doc;
  });
}
