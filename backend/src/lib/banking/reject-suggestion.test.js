import { describe, expect, it, vi } from 'vitest';
import { rejectSuggestedLine } from './reject-suggestion.js';

describe('rejectSuggestedLine', () => {
  it('returns a suggested line to unmatched and clears the proposed match', async () => {
    const suggested = {
      id: 'line-1',
      organizationId: 'org-1',
      status: 'SUGGESTED',
      matchedJournalLineId: 'journal-line-1',
    };
    const db = {
      bankStatementLine: {
        findFirst: vi.fn().mockResolvedValue(suggested),
        update: vi.fn().mockImplementation(({ data }) => Promise.resolve({ ...suggested, ...data })),
      },
    };

    const result = await rejectSuggestedLine(db, 'org-1', 'line-1');

    expect(db.bankStatementLine.findFirst).toHaveBeenCalledWith({
      where: { id: 'line-1', organizationId: 'org-1' },
    });
    expect(db.bankStatementLine.update).toHaveBeenCalledWith({
      where: { id: 'line-1', organizationId: 'org-1', status: 'SUGGESTED' },
      data: {
        status: 'UNMATCHED',
        matchedJournalLineId: null,
        matchConfidence: null,
        matchedBy: null,
        matchedAt: null,
      },
    });
    expect(result.status).toBe('UNMATCHED');
  });

  it('refuses to reject a line that is not a suggestion', async () => {
    const db = {
      bankStatementLine: {
        findFirst: vi.fn().mockResolvedValue({ id: 'line-1', status: 'MATCHED' }),
      },
    };

    await expect(rejectSuggestedLine(db, 'org-1', 'line-1')).rejects.toMatchObject({
      code: 'line_not_suggested',
      status: 422,
    });
  });
});
