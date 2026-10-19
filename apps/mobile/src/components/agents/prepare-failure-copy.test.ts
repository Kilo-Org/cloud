import { beforeEach, describe, expect, it, vi } from 'vitest';

import { prepareFailureMessage } from './prepare-failure-copy';
import { i18n } from '@/i18n';

// The real retryability predicate lives in mobile-session-manager; these tests
// pin the copy decision, so a plain retryable flag stands in for it.
const GENERIC = i18n.t('agentChat.newSession.couldNotStartSessionNow');

function errorWith(code: string, message: string): Error {
  return Object.assign(new Error(message), { data: { code } });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('prepareFailureMessage', () => {
  it.each([
    ['PAYMENT_REQUIRED', 'Insufficient credits for this session'],
    ['UNAUTHORIZED', 'Sign in again to continue'],
    ['FORBIDDEN', 'You do not have access to this repository'],
    ['NOT_FOUND', 'Repository not found'],
    ['UNPROCESSABLE_CONTENT', 'Branch no longer exists'],
  ])('keeps the server reason for an actionable %s refusal', (code, message) => {
    expect(prepareFailureMessage(errorWith(code, message), false)).toBe(message);
  });

  it.each([
    ['BAD_REQUEST', 'Runtime credential proxy configuration is unavailable'],
    ['INTERNAL_SERVER_ERROR', 'NEXTAUTH_SECRET is not configured on the worker'],
    ['SERVICE_UNAVAILABLE', 'internal detail'],
    ['CONFLICT', 'creation_in_progress'],
  ])('replaces the server reason with generic copy for %s', (code, message) => {
    const shown = prepareFailureMessage(errorWith(code, message), false);
    expect(shown).toBe(GENERIC);
    expect(shown).not.toContain(message);
  });

  it('replaces the server reason when the message is empty', () => {
    expect(prepareFailureMessage(errorWith('NOT_FOUND', ''), false)).toBe(GENERIC);
  });

  it('uses generic copy for a codeless transport error', () => {
    expect(prepareFailureMessage(new Error('Network request failed'), true)).toBe(GENERIC);
  });

  it('uses generic copy for a non-Error rejection', () => {
    expect(prepareFailureMessage(undefined, true)).toBe(GENERIC);
  });

  it('never shows a server message for a retryable failure', () => {
    expect(prepareFailureMessage(errorWith('PAYMENT_REQUIRED', 'Insufficient credits'), true)).toBe(
      GENERIC
    );
  });

  it('reads the shaped error form (shape.data.code) too', () => {
    const shaped = {
      shape: { data: { code: 'FORBIDDEN', message: 'No repository access' } },
    };
    expect(prepareFailureMessage(shaped, false)).toBe('No repository access');
  });
});
