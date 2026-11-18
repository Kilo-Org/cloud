import { TRPCClientError } from '@trpc/client';
import {
  getStandaloneSessionRefetchInterval,
  nextPrLinkVerification,
  PR_LINK_ATTEMPT_HISTORY_LIMIT,
  recordPrLinkVerificationAttempt,
  shouldRetryPrLinkVerification,
} from './useStandaloneSessions';

describe('standalone polling', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  const idle = {
    status: 'idle',
    updated_at: new Date(now).toISOString(),
    latest_run_status: 'completed',
  };
  it('does not poll completed rows', () => {
    expect(getStandaloneSessionRefetchInterval([idle], now)).toBe(false);
  });
  it.each(['busy', 'retry'])('polls fresh %s rows, but stops at three hours', status => {
    expect(getStandaloneSessionRefetchInterval([{ ...idle, status }], now)).toBe(30_000);
    expect(getStandaloneSessionRefetchInterval([{ ...idle, status }], now + 3 * 60 * 60_000)).toBe(
      false
    );
  });
  it.each(['queued', 'accepted'])(
    'polls a %s run without treating a cloud-agent ID as activity',
    latest_run_status => {
      expect(getStandaloneSessionRefetchInterval([{ ...idle, latest_run_status }], now)).toBe(
        30_000
      );
    }
  );
  it('polls pending PR information quickly', () => {
    expect(
      getStandaloneSessionRefetchInterval(
        [{ ...idle, associatedPr: { reviewDecisionPending: true } }],
        now
      )
    ).toBe(5_000);
  });
});

describe('PR verification', () => {
  it('bounds remembered verification attempts and keeps the newest evidence', () => {
    const attempts = new Map<string, string>();
    for (let index = 0; index <= PR_LINK_ATTEMPT_HISTORY_LIMIT; index++)
      recordPrLinkVerificationAttempt(attempts, `ses_${index}`, 'old');
    expect(attempts.size).toBe(PR_LINK_ATTEMPT_HISTORY_LIMIT);
    expect(attempts.has('ses_0')).toBe(false);
    recordPrLinkVerificationAttempt(attempts, 'ses_1', 'new');
    expect(attempts.get('ses_1')).toBe('new');
    expect(
      nextPrLinkVerification([{ session_id: 'ses_1', prLinkVerificationKey: 'new' }], attempts)
    ).toBeUndefined();
    expect(
      nextPrLinkVerification([{ session_id: 'ses_1', prLinkVerificationKey: 'changed' }], attempts)
        ?.session_id
    ).toBe('ses_1');
  });
  it('retries transport failures only once', () => {
    const error = TRPCClientError.from(new TypeError('Failed to fetch'));
    expect(shouldRetryPrLinkVerification(0, error)).toBe(true);
    expect(shouldRetryPrLinkVerification(1, error)).toBe(false);
    expect(shouldRetryPrLinkVerification(0, new Error('Unknown failure'))).toBe(false);
  });
});
