import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONTROL_DIAGNOSTIC_COALESCE_LIMIT, logControlDiagnostic } from './diagnostics.js';
import { logger } from '../logger.js';

describe('logControlDiagnostic', () => {
  const withFields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
  const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);

  afterEach(() => {
    withFields.mockClear();
    info.mockClear();
  });

  it('keeps safe preparation fields and coalesces identical rejection results', () => {
    const identity = `test:${crypto.randomUUID()}`;
    const fields = {
      sessionId: 'workspace_11111111-1111-4111-8111-111111111111',
      receiptId: '22222222-2222-4222-8222-222222222222',
      attemptId: 'attempt_1',
      action: 'attempt_started',
      revision: 4,
      disposition: 'runtime_mismatch',
      applied: false,
      durationMs: 1,
    };

    logControlDiagnostic('session_preparing_result', fields, 'info', {
      coalesceIdentity: identity,
    });
    logControlDiagnostic('session_preparing_result', { ...fields, durationMs: 99 }, 'info', {
      coalesceIdentity: identity,
    });
    logControlDiagnostic(
      'session_preparing_result',
      { ...fields, disposition: 'native_runtime_mismatch' },
      'info',
      { coalesceIdentity: identity }
    );

    expect(withFields).toHaveBeenCalledTimes(3);
    expect(withFields.mock.calls[0]?.[0]).toMatchObject({
      attemptId: 'attempt_1',
      action: 'attempt_started',
      revision: 4,
      disposition: 'runtime_mismatch',
    });
    expect(withFields.mock.calls[1]?.[0]).toMatchObject({
      disposition: 'runtime_mismatch',
      occurrences: 2,
    });
    expect(withFields.mock.calls[2]?.[0]).toMatchObject({
      disposition: 'native_runtime_mismatch',
    });
  });

  it('evicts the oldest coalescing identity at the fixed bound', () => {
    const prefix = `eviction:${crypto.randomUUID()}:`;
    const fields = { applied: false, disposition: 'receipt_conflict' };
    for (let index = 0; index <= CONTROL_DIAGNOSTIC_COALESCE_LIMIT; index += 1) {
      logControlDiagnostic('session_event_result', fields, 'info', {
        coalesceIdentity: `${prefix}${index}`,
      });
    }
    withFields.mockClear();
    logControlDiagnostic('session_event_result', fields, 'info', {
      coalesceIdentity: `${prefix}0`,
    });
    expect(withFields).toHaveBeenCalledTimes(1);
  });
});
