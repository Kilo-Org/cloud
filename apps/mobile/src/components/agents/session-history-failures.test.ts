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
  // Literal rows, so a changed or swapped message or code fails below. The
  // guard case underneath keeps the table exhaustive as kinds are added.
  const FAILURE_ROWS = [
    ['retryable_failure', 'Session history temporarily unavailable', 'INTERNAL_SERVER_ERROR'],
    ['too_large', 'Session history too large to load', 'UNPROCESSABLE_CONTENT'],
    ['invalid_data', 'Session history is unavailable', 'UNPROCESSABLE_CONTENT'],
  ] as const;

  it.each(FAILURE_ROWS)(
    'keeps the %s failure name, message and code the preview reads',
    (kind, message, code) => {
      const error = new SessionHistoryFailureError(SESSION_HISTORY_FAILURES[kind]);

      expect(error.name).toBe('SessionHistoryFailureError');
      expect(error.message).toBe(message);
      expect(error.code).toBe(code);
    }
  );

  it('lists a row for every declared failure kind', () => {
    // `SessionHistoryFailureKind` derives from the object, so a new kind cannot
    // fail to type-check the table above; this case fails instead.
    expect(Object.keys(SESSION_HISTORY_FAILURES).sort()).toEqual(
      FAILURE_ROWS.map(([kind]) => kind).sort()
    );
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
