import { dec, eq } from '../money.js';

const AMOUNT_WEIGHT = 0.55;
const DATE_WEIGHT = 0.25;
const REFERENCE_WEIGHT = 0.20;
export const AUTO_MATCH_THRESHOLD = 0.90;
export const SUGGEST_THRESHOLD = 0.45;
const TIE_EPSILON = 1e-9;

function dateScore(days) {
  const d = Math.abs(days);
  if (d === 0) return 1.0;
  if (d === 1) return 0.9;
  if (d <= 3) return 0.7;
  if (d <= 7) return 0.4;
  return 0;
}

function daysBetween(a, b) {
  return Math.round((new Date(a) - new Date(b)) / 86_400_000);
}

// Posted journal lines on the bank account's GL account, not already claimed
// by another statement line, within a week of the statement line's date
// (§7 candidate pool). One query per statement line — the date window and
// the trigram similarity against THIS line's description both depend on it.
async function findCandidates(tx, { organizationId, glAccountId, statementLine }) {
  return tx.$queryRaw`
    SELECT jl.id, jl.debit, jl.credit, je."entryDate" AS entry_date,
           d."docNo" AS doc_no, d."referenceNo" AS reference_no,
           similarity(lower(${statementLine.description}), lower(COALESCE(p.name, ''))) AS name_similarity
    FROM "JournalLine" jl
    JOIN "JournalEntry" je ON je.id = jl."journalEntryId"
    LEFT JOIN "Document" d ON d."journalEntryId" = je.id
    LEFT JOIN "Party" p ON p.id = d."partyId"
    WHERE jl."organizationId" = ${organizationId}
      AND jl."accountId" = ${glAccountId}
      AND je.status = 'POSTED'
      AND je."entryDate" BETWEEN ${statementLine.txnDate}::date - INTERVAL '7 days'
                              AND ${statementLine.txnDate}::date + INTERVAL '7 days'
      AND jl.id NOT IN (
        SELECT "matchedJournalLineId" FROM "BankStatementLine" WHERE "matchedJournalLineId" IS NOT NULL
      )
  `;
}

// Amount is a hard gate, not a weight (§7): off by even one paisa, or on the
// wrong side of the entry (RECON-6 — a statement credit only ever matches a
// journal DEBIT on the bank account, never a credit), and the score is zero.
function scoreCandidate(statementLine, candidate) {
  const stmtIsCredit = dec(statementLine.credit).gt(0);
  const stmtAmount = stmtIsCredit ? dec(statementLine.credit) : dec(statementLine.debit);
  const matchAmount = stmtIsCredit ? dec(candidate.debit) : dec(candidate.credit);

  if (matchAmount.isZero() || !eq(matchAmount, stmtAmount)) return 0;

  const dScore = dateScore(daysBetween(statementLine.txnDate, candidate.entry_date));

  const docNoHit = candidate.doc_no && statementLine.description.toUpperCase().includes(String(candidate.doc_no).toUpperCase()) ? 1 : 0;
  const referenceHit = candidate.reference_no && statementLine.reference && candidate.reference_no === statementLine.reference ? 1 : 0;
  const nameSimilarity = Number(candidate.name_similarity ?? 0);
  const rScore = Math.max(docNoHit, referenceHit, nameSimilarity);

  return AMOUNT_WEIGHT * 1 + DATE_WEIGHT * dScore + REFERENCE_WEIGHT * rScore;
}

// Four-pass scoring + greedy bipartite assignment (§7). Returns one decision
// per input statement line: { statementLineId, journalLineId, status,
// matchedBy, confidence }. Never writes to the DB — the caller (the import
// pipeline / re-match) persists the result inside its own transaction.
export async function matchStatementLines(tx, { organizationId, glAccountId, statementLines }) {
  const perLine = new Map(); // statementLineId -> sorted [{journalLineId, score}]

  for (const line of statementLines) {
    const candidates = await findCandidates(tx, { organizationId, glAccountId, statementLine: line });
    const scored = candidates
      .map((c) => ({ journalLineId: c.id, score: scoreCandidate(line, c) }))
      .filter((c) => c.score > SUGGEST_THRESHOLD)
      .sort((a, b) => b.score - a.score);
    perLine.set(line.id, scored);
  }

  // A line whose own top two candidates score equally is ambiguous — the
  // matcher cannot tell which one is right, so it must never auto-confirm
  // for that line even if the tied score clears 0.90 (§7 edge cases: "two
  // identical amounts on the same day" — RECON-3). Computed against the
  // FULL per-line candidate list, before any candidate is claimed below.
  const ambiguous = new Set();
  for (const [lineId, scored] of perLine) {
    if (scored.length >= 2 && scored[0].score - scored[1].score < TIE_EPSILON) {
      ambiguous.add(lineId);
    }
  }

  const triples = [];
  for (const [statementLineId, scored] of perLine) {
    for (const c of scored) triples.push({ statementLineId, journalLineId: c.journalLineId, score: c.score });
  }
  triples.sort((a, b) => b.score - a.score);

  const claimedLines = new Set();
  const claimedJournalLines = new Set();
  const assignments = new Map();

  for (const t of triples) {
    if (claimedLines.has(t.statementLineId) || claimedJournalLines.has(t.journalLineId)) continue;
    claimedLines.add(t.statementLineId);
    claimedJournalLines.add(t.journalLineId);
    assignments.set(t.statementLineId, t);
  }

  return statementLines.map((line) => {
    const a = assignments.get(line.id);
    if (!a) return { statementLineId: line.id, journalLineId: null, status: 'UNMATCHED', matchedBy: null, confidence: null };

    const canAutoConfirm = a.score >= AUTO_MATCH_THRESHOLD && !ambiguous.has(line.id);
    return {
      statementLineId: line.id,
      journalLineId: a.journalLineId,
      status: canAutoConfirm ? 'MATCHED' : 'SUGGESTED',
      matchedBy: canAutoConfirm ? 'AUTO' : null,
      confidence: a.score,
    };
  });
}
