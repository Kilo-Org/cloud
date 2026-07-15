import { describe, expect, it } from 'vitest';

import {
  classifyLocalSessionCreateError,
  type LocalSessionCreateRecovery,
} from './local-session-create-errors';

type RetryableKind = 'fence-changed' | 'catalog-changed' | 'transient' | 'limit';

const RETRYABLE_CODES: { code: string; expectedKind: RetryableKind }[] = [
  { code: 'RUNTIME_NOT_CONNECTED', expectedKind: 'fence-changed' },
  { code: 'RUNTIME_FENCE_MISMATCH', expectedKind: 'fence-changed' },
  { code: 'CATALOG_CHANGED', expectedKind: 'catalog-changed' },
  { code: 'COMMAND_EXPIRED', expectedKind: 'transient' },
  { code: 'RUNTIME_COMMAND_FAILED', expectedKind: 'transient' },
  { code: 'COMMAND_ALREADY_PENDING', expectedKind: 'transient' },
  { code: 'PENDING_COMMAND_LIMIT', expectedKind: 'limit' },
];

const NON_RETRYABLE_CODES = ['CLI_UPGRADE_REQUIRED'];

const MALFORMED_CODES = ['RESULT_TOO_LARGE', 'INVALID_RUNTIME_RESPONSE', 'COMMAND_NOT_ALLOWED'];

describe('classifyLocalSessionCreateError', () => {
  it('classifies every retryable upstream code with the exact message and CTA copy', () => {
    for (const { code, expectedKind } of RETRYABLE_CODES) {
      const result: LocalSessionCreateRecovery = classifyLocalSessionCreateError({
        data: { upstreamCode: code },
      });
      expect(result.kind).toBe(expectedKind);
      if (result.kind === 'fence-changed') {
        expect(result.message).toBe(
          'Local runtime disconnected. Select a connected runtime and try again.'
        );
        expect(result.ctaLabel).toBe('Select runtime');
      } else if (result.kind === 'catalog-changed') {
        expect(result.message).toBe(
          'The runtime catalog changed. Review the model and agent, then try again.'
        );
        expect(result.ctaLabel).toBe('Refresh catalog');
      } else if (result.kind === 'transient') {
        expect(result.message).toBe(
          "We couldn't confirm whether the session started. Retry with the same request."
        );
      } else {
        expect(result.kind).toBe('limit');
        expect(result.message).toBe(
          'This runtime is handling too many requests. Try again in a moment.'
        );
      }
      if (result.kind === 'transient' || result.kind === 'limit') {
        expect(result.ctaLabel).toBe('Retry');
      }
    }
  });

  it('classifies CLI_UPGRADE_REQUIRED as non-retryable with no Retry CTA', () => {
    for (const code of NON_RETRYABLE_CODES) {
      const result = classifyLocalSessionCreateError({ data: { upstreamCode: code } });
      expect(result.kind).toBe('non-retryable-cli-upgrade');
      if (result.kind !== 'non-retryable-cli-upgrade') {
        throw new Error('expected non-retryable-cli-upgrade');
      }
      expect(result.message).toBe('Update Kilo CLI and reconnect.');
      expect(result.ctaLabel).toBeNull();
    }
  });

  it('classifies the malformed response codes as non-retryable with no Retry CTA', () => {
    for (const code of MALFORMED_CODES) {
      const result = classifyLocalSessionCreateError({ data: { upstreamCode: code } });
      expect(result.kind).toBe('non-retryable-malformed');
      if (result.kind !== 'non-retryable-malformed') {
        throw new Error('expected non-retryable-malformed');
      }
      expect(result.message).toBe(
        'This runtime returned an unsupported response. Update Kilo CLI and reconnect.'
      );
      expect(result.ctaLabel).toBeNull();
    }
  });

  it('classifies SESSION_NOT_READY (server wait exhausted) as a recovery-poll branch', () => {
    const result = classifyLocalSessionCreateError({
      data: { upstreamCode: 'SESSION_NOT_READY' },
    });
    expect(result.kind).toBe('readiness-timeout');
    if (result.kind !== 'readiness-timeout') {
      throw new Error('expected readiness-timeout');
    }
    expect(result.message).toBe("Session created, but it isn't ready in the app yet.");
    expect(result.ctaLabel).toBe('Check again');
  });

  it('classifies a missing upstream code as transient retryable with the safe default copy', () => {
    const result = classifyLocalSessionCreateError({ data: {} });
    expect(result.kind).toBe('transient');
    if (result.kind !== 'transient') {
      throw new Error('expected transient');
    }
    expect(result.message).toBe(
      "We couldn't confirm whether the session started. Retry with the same request."
    );
    expect(result.ctaLabel).toBe('Retry');
  });

  it('classifies an unknown upstream code value as transient retryable', () => {
    const result = classifyLocalSessionCreateError({
      data: { upstreamCode: 'SOMETHING_NEW' },
    });
    expect(result.kind).toBe('transient');
  });

  it('classifies a plain Error (no tRPC envelope) as transient retryable', () => {
    const result = classifyLocalSessionCreateError(new Error('network down'));
    expect(result.kind).toBe('transient');
  });

  it('classifies non-object throwables as transient retryable', () => {
    expect(classifyLocalSessionCreateError('string-error').kind).toBe('transient');
    expect(classifyLocalSessionCreateError(null).kind).toBe('transient');
    expect(classifyLocalSessionCreateError(undefined).kind).toBe('transient');
  });
});
