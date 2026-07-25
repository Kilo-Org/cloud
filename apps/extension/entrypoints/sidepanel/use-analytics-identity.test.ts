import { describe, expect, it, vi } from 'vitest';

const analyticsMocks = vi.hoisted(() => ({
  captureEvent: vi.fn(),
  initAnalytics: vi.fn(),
}));

// Match the import specifier used by use-analytics-identity.ts.
// eslint-disable-next-line vitest/prefer-import-in-mock, jest/no-untyped-mock-factory
vi.mock('@/src/shared/analytics', () => ({
  EXTENSION_SIGNED_IN_EVENT: 'extension_signed_in',
  captureEvent: analyticsMocks.captureEvent,
  initAnalytics: analyticsMocks.initAnalytics,
}));

// eslint-disable-next-line import/first
import type { AnalyticsStorageArea } from '@/src/shared/analytics';
// eslint-disable-next-line import/first
import {
  createAnalyticsIdentityTracker,
  resolveSignedInTransition,
} from './use-analytics-identity';

const EMAIL = 'user@kilo.ai';
const OTHER_EMAIL = 'other@kilo.ai';

const storageArea: AnalyticsStorageArea = {
  getItem: vi.fn(),
  setItem: vi.fn(),
};

const signedIn = (email: string | undefined = EMAIL) => ({ email, status: 'signedIn' }) as const;

const emailLessSignedIn = { email: undefined as string | undefined, status: 'signedIn' as const };

const signedOut = { email: undefined, status: 'signedOut' } as const;

const resetMocks = (): void => {
  analyticsMocks.captureEvent.mockReset();
  analyticsMocks.initAnalytics.mockReset();
};

describe('signed-in transition decision', () => {
  it('identifies on cold start (previous undefined → signedIn with email)', () => {
    expect(resolveSignedInTransition(undefined, signedIn())).toBe('identify');
  });

  it('identifies on device approval (previous signedOut → signedIn with email)', () => {
    expect(resolveSignedInTransition(signedOut, signedIn())).toBe('identify');
  });

  it('identifies when email arrives after an email-less signedIn', () => {
    expect(resolveSignedInTransition(emailLessSignedIn, signedIn(EMAIL))).toBe('identify');
  });

  it('identifies on re-sign-in after sign-out with the same email', () => {
    expect(resolveSignedInTransition(signedOut, signedIn(EMAIL))).toBe('identify');
  });

  it('returns null for same-email re-render while still signed in', () => {
    expect(resolveSignedInTransition(signedIn(EMAIL), signedIn(EMAIL))).toBeNull();
  });

  it('returns null for email-less signedIn', () => {
    expect(resolveSignedInTransition(undefined, emailLessSignedIn)).toBeNull();
    expect(resolveSignedInTransition(undefined, { email: '', status: 'signedIn' })).toBeNull();
  });

  it('returns null when next is not signedIn', () => {
    expect(resolveSignedInTransition(undefined, signedOut)).toBeNull();
    expect(
      resolveSignedInTransition(signedIn(), { email: EMAIL, status: 'validationError' })
    ).toBeNull();
  });

  it('identifies when the signed-in email changes', () => {
    expect(resolveSignedInTransition(signedIn(EMAIL), signedIn(OTHER_EMAIL))).toBe('identify');
  });
});

describe('analytics identity tracker', () => {
  const createTracker = () => {
    const emitSignedIn = vi.fn();
    const tracker = createAnalyticsIdentityTracker({
      emitSignedIn,
      storageArea,
    });
    return { emitSignedIn, tracker };
  };

  it('re-identifies on signedOut → signedIn with the same email', async () => {
    resetMocks();
    analyticsMocks.initAnalytics.mockResolvedValue(true);
    const { emitSignedIn, tracker } = createTracker();

    await tracker.observe(signedIn(EMAIL), 'stored_session');
    // eslint-disable-next-line vitest/prefer-called-once
    expect(analyticsMocks.initAnalytics).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line vitest/prefer-called-once
    expect(emitSignedIn).toHaveBeenCalledTimes(1);

    await tracker.observe(signedOut, 'stored_session');
    await tracker.observe(signedIn(EMAIL), 'device_auth');

    expect(analyticsMocks.initAnalytics).toHaveBeenCalledTimes(2);
    expect(emitSignedIn).toHaveBeenCalledTimes(2);
    expect(emitSignedIn).toHaveBeenLastCalledWith('device_auth');
  });

  it('dedupes identical observations across runs to a single init+emit', async () => {
    resetMocks();
    analyticsMocks.initAnalytics.mockResolvedValue(true);
    const { emitSignedIn, tracker } = createTracker();

    await tracker.observe(signedIn(EMAIL), 'stored_session');
    await tracker.observe(signedIn(EMAIL), 'stored_session');
    await tracker.observe(signedIn(EMAIL), 'device_auth');

    // eslint-disable-next-line vitest/prefer-called-once
    expect(analyticsMocks.initAnalytics).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line vitest/prefer-called-once
    expect(emitSignedIn).toHaveBeenCalledTimes(1);
    expect(emitSignedIn).toHaveBeenCalledWith('stored_session');
  });

  it('does not emit extension_signed_in when initAnalytics returns false', async () => {
    resetMocks();
    analyticsMocks.initAnalytics.mockResolvedValue(false);
    const { emitSignedIn, tracker } = createTracker();

    await tracker.observe(signedIn(EMAIL), 'stored_session');

    // eslint-disable-next-line vitest/prefer-called-once
    expect(analyticsMocks.initAnalytics).toHaveBeenCalledTimes(1);
    expect(emitSignedIn).not.toHaveBeenCalled();
  });

  it('emits device_auth source for a device-approval observation', async () => {
    resetMocks();
    analyticsMocks.initAnalytics.mockResolvedValue(true);
    const { emitSignedIn, tracker } = createTracker();

    await tracker.observe(signedIn(EMAIL), 'device_auth');

    expect(emitSignedIn).toHaveBeenCalledWith('device_auth');
  });

  it('emits stored_session source on cold start', async () => {
    resetMocks();
    analyticsMocks.initAnalytics.mockResolvedValue(true);
    const { emitSignedIn, tracker } = createTracker();

    await tracker.observe(signedIn(EMAIL), 'stored_session');

    expect(emitSignedIn).toHaveBeenCalledWith('stored_session');
  });

  it('advances previous on signedOut/undefined so a later re-identify works', async () => {
    resetMocks();
    analyticsMocks.initAnalytics.mockResolvedValue(true);
    const { emitSignedIn, tracker } = createTracker();

    await tracker.observe(signedIn(EMAIL), 'stored_session');
    // eslint-disable-next-line vitest/prefer-called-once
    expect(emitSignedIn).toHaveBeenCalledTimes(1);

    // Observe undefined status (query disabled after sign-out) without identify.
    await tracker.observe({ email: undefined, status: undefined }, 'stored_session');
    // eslint-disable-next-line vitest/prefer-called-once
    expect(emitSignedIn).toHaveBeenCalledTimes(1);

    await tracker.observe(signedIn(EMAIL), 'stored_session');
    expect(emitSignedIn).toHaveBeenCalledTimes(2);
  });

  it('advances previous before await so an in-flight observe does not use stale previous', async () => {
    resetMocks();
    const deferred = Promise.withResolvers<boolean>();
    analyticsMocks.initAnalytics.mockReturnValue(deferred.promise);

    const { emitSignedIn, tracker } = createTracker();

    const first = tracker.observe(signedIn(EMAIL), 'stored_session');
    /*
     * While first init is in flight, a newer identical observation must see
     * previous already advanced to signedIn+email and skip identify.
     */
    const second = tracker.observe(signedIn(EMAIL), 'device_auth');

    // eslint-disable-next-line vitest/prefer-called-once
    expect(analyticsMocks.initAnalytics).toHaveBeenCalledTimes(1);

    deferred.resolve(true);
    await Promise.all([first, second]);

    // eslint-disable-next-line vitest/prefer-called-once
    expect(analyticsMocks.initAnalytics).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line vitest/prefer-called-once
    expect(emitSignedIn).toHaveBeenCalledTimes(1);
    expect(emitSignedIn).toHaveBeenCalledWith('stored_session');
  });

  it('does not identify when signedIn has no email', async () => {
    resetMocks();
    analyticsMocks.initAnalytics.mockResolvedValue(true);
    const { emitSignedIn, tracker } = createTracker();

    await tracker.observe(emailLessSignedIn, 'stored_session');
    await tracker.observe({ email: '', status: 'signedIn' }, 'stored_session');

    expect(analyticsMocks.initAnalytics).not.toHaveBeenCalled();
    expect(emitSignedIn).not.toHaveBeenCalled();
  });
});
