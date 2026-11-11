import { describe, expect, it } from 'vitest';

import { TELEMETRY_DESCRIPTION_KEY } from '@/lib/telemetry/error-sink';

import {
  SESSION_HISTORY_FAILURES,
  SessionHistoryFailureError,
  TERMINAL_SESSION_HISTORY_FAILURE_MESSAGES,
} from './session-history-failures';

function declaredTelemetry(error: Error): unknown {
  return Reflect.get(error, TELEMETRY_DESCRIPTION_KEY);
}

describe('SessionHistoryFailureError', () => {
  it('keeps the failure type, message and code the preview reads', () => {
    for (const failure of Object.values(SESSION_HISTORY_FAILURES)) {
      const error = new SessionHistoryFailureError(failure);

      expect(error.name).toBe('SessionHistoryFailureError');
      expect(error.message).toBe(failure.message);
      expect(error.code).toBe(failure.code);
    }
  });

  it('files the expected transient outage as one warning with its own kind', () => {
    const error = new SessionHistoryFailureError(SESSION_HISTORY_FAILURES.retryable_failure);

    expect(declaredTelemetry(error)).toEqual({
      level: 'warning',
      fingerprint: ['session-history-page', 'retryable_failure'],
      tags: { 'error.subsystem': 'session-history', 'error.operation': 'read-page' },
    });
  });

  it.each([
    ['too_large', SESSION_HISTORY_FAILURES.too_large],
    ['invalid_data', SESSION_HISTORY_FAILURES.invalid_data],
  ] as const)('keeps the terminal %s outcome at its own error fingerprint', (kind, failure) => {
    const error = new SessionHistoryFailureError(failure);

    expect(declaredTelemetry(error)).toEqual({
      level: 'error',
      fingerprint: ['session-history-page', kind],
      tags: { 'error.subsystem': 'session-history', 'error.operation': 'read-page' },
    });
    expect(TERMINAL_SESSION_HISTORY_FAILURE_MESSAGES).toContain(failure.message);
  });
});
