import { describe, it, expect } from 'vitest';
import { safeErrorLog } from './log-redact.js';

describe('safeErrorLog', () => {
  it('keeps message and stack, redacts sensitive extra properties by key name', () => {
    const err = new Error('boom');
    err.status = 500;
    err.jwtSecret = 'super-secret-value';
    err.userPassword = 'hunter2';
    err.details = { refreshToken: 'abc123', accountId: 'keep-me' };

    const logged = safeErrorLog(err);

    expect(logged.message).toBe('boom');
    expect(logged.stack).toContain('Error: boom');
    expect(logged.status).toBe(500);
    expect(logged.jwtSecret).toBe('[REDACTED]');
    expect(logged.userPassword).toBe('[REDACTED]');
    expect(logged.details.refreshToken).toBe('[REDACTED]');
    expect(logged.details.accountId).toBe('keep-me');
  });
});
