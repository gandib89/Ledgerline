// Locked-counter numbering (§5 document_series): allocate from a row locked
// with SELECT ... FOR UPDATE inside the posting transaction, then increment.
// Never MAX(doc_no)+1 — under concurrency that produces duplicates, and
// duplicate invoice numbers are a statutory problem, not a cosmetic one.

function formatNumber(prefix, yearLabel, number, padding) {
  return `${prefix}-${yearLabel}-${String(number).padStart(padding, '0')}`;
}

// doc_no: one series per (organization, docType, fiscalYear) — INV-2082-0001,
// CN-2082-0001, etc. each count independently.
export async function nextDocNumber(tx, { organizationId, docType, fiscalYearId, prefix, yearLabel }) {
  await tx.$executeRaw`
    INSERT INTO "DocumentSeries" (id, "organizationId", "docType", "fiscalYearId", prefix, padding, "nextNumber")
    VALUES (gen_random_uuid(), ${organizationId}, ${docType}::"DocType", ${fiscalYearId}, ${prefix}, 4, 1)
    ON CONFLICT ("organizationId", "docType", "fiscalYearId") DO NOTHING
  `;
  const [series] = await tx.$queryRaw`
    SELECT * FROM "DocumentSeries"
    WHERE "organizationId" = ${organizationId} AND "docType" = ${docType}::"DocType" AND "fiscalYearId" = ${fiscalYearId}
    FOR UPDATE
  `;
  await tx.$executeRaw`UPDATE "DocumentSeries" SET "nextNumber" = "nextNumber" + 1 WHERE id = ${series.id}`;
  return formatNumber(series.prefix, yearLabel, series.nextNumber, series.padding);
}

// entry_no: one shared series per (organization, fiscalYear) across every
// source type — invoice-, receipt- and manual-sourced entries interleave in
// the same JE-#### sequence (§6 worked examples), unlike doc_no above.
export async function nextEntryNumber(tx, { organizationId, fiscalYearId, yearLabel }) {
  await tx.$executeRaw`
    INSERT INTO "EntrySeries" (id, "organizationId", "fiscalYearId", prefix, padding, "nextNumber")
    VALUES (gen_random_uuid(), ${organizationId}, ${fiscalYearId}, 'JE', 4, 1)
    ON CONFLICT ("organizationId", "fiscalYearId") DO NOTHING
  `;
  const [series] = await tx.$queryRaw`
    SELECT * FROM "EntrySeries"
    WHERE "organizationId" = ${organizationId} AND "fiscalYearId" = ${fiscalYearId}
    FOR UPDATE
  `;
  await tx.$executeRaw`UPDATE "EntrySeries" SET "nextNumber" = "nextNumber" + 1 WHERE id = ${series.id}`;
  return formatNumber(series.prefix, yearLabel, series.nextNumber, series.padding);
}
