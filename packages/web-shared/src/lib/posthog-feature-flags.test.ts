import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';

jest.mock('@kilocode/web-shared/lib/posthog', () => {
  const mockGetFeatureFlag = jest.fn();

  return {
    __esModule: true,
    default: jest.fn(() => ({
      getFeatureFlag: mockGetFeatureFlag,
    })),
    mockGetFeatureFlag,
  };
});

jest.mock('@sentry/nextjs', () => {
  const mockCaptureException = jest.fn();
  const mockStartSpan = jest.fn(async (_context: unknown, callback: () => Promise<unknown>) => {
    return await callback();
  });

  return {
    captureException: mockCaptureException,
    startSpan: mockStartSpan,
    mockCaptureException,
  };
});

import {
  isFeatureFlagEnabled,
  isFeatureFlagEnabledOrDevelopment,
  isReleaseToggleEnabled,
  resetFeatureFlagCache,
} from '@kilocode/web-shared/lib/posthog-feature-flags';

const posthogMock: {
  mockGetFeatureFlag: jest.Mock;
} = jest.requireMock('@kilocode/web-shared/lib/posthog');

const sentryMock: {
  mockCaptureException: jest.Mock;
} = jest.requireMock('@sentry/nextjs');

const { mockGetFeatureFlag } = posthogMock;
const { mockCaptureException } = sentryMock;

beforeEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
  resetFeatureFlagCache();
});

describe('isFeatureFlagEnabledOrDevelopment', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns true without querying PostHog in development', async () => {
    const replacedEnv = jest.replaceProperty(process, 'env', {
      ...process.env,
      NODE_ENV: 'development',
    });

    try {
      await expect(
        isFeatureFlagEnabledOrDevelopment('cloud-agent-devcontainer', 'user-1')
      ).resolves.toBe(true);
      expect(mockGetFeatureFlag).not.toHaveBeenCalled();
    } finally {
      replacedEnv.restore();
    }
  });

  test('queries PostHog outside development', async () => {
    const replacedEnv = jest.replaceProperty(process, 'env', {
      ...process.env,
      NODE_ENV: 'production',
    });
    mockGetFeatureFlag.mockResolvedValueOnce(true);

    try {
      await expect(
        isFeatureFlagEnabledOrDevelopment('cloud-agent-devcontainer', 'user-2')
      ).resolves.toBe(true);
      expect(mockGetFeatureFlag).toHaveBeenCalledWith('cloud-agent-devcontainer', 'user-2', {
        personProperties: undefined,
      });
    } finally {
      replacedEnv.restore();
    }
  });
});

describe('isReleaseToggleEnabled', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns true only when PostHog flag value is boolean true', async () => {
    mockGetFeatureFlag.mockResolvedValueOnce(true);

    await expect(isReleaseToggleEnabled('kiloclaw', 'user-1')).resolves.toBe(true);
    expect(mockGetFeatureFlag).toHaveBeenCalledWith('kiloclaw', 'user-1', {
      personProperties: undefined,
    });
  });

  test('passes person properties to the SDK for targeted release toggles', async () => {
    mockGetFeatureFlag.mockResolvedValueOnce(true);
    await expect(
      isReleaseToggleEnabled('employee-feature', 'employee', { email: 'employee@kilocode.ai' })
    ).resolves.toBe(true);
    expect(mockGetFeatureFlag).toHaveBeenCalledWith('employee-feature', 'employee', {
      personProperties: { email: 'employee@kilocode.ai' },
    });
  });

  test('returns false when PostHog flag value is boolean false', async () => {
    mockGetFeatureFlag.mockResolvedValueOnce(false);

    await expect(isReleaseToggleEnabled('kiloclaw', 'user-2')).resolves.toBe(false);
  });

  test('returns false for multivariate string values', async () => {
    mockGetFeatureFlag.mockResolvedValueOnce('enabled-variant');

    await expect(isReleaseToggleEnabled('kiloclaw', 'user-3')).resolves.toBe(false);
  });

  test('returns false when PostHog throws', async () => {
    mockGetFeatureFlag.mockRejectedValueOnce(new Error('posthog failure'));

    await expect(isReleaseToggleEnabled('kiloclaw', 'user-4')).resolves.toBe(false);
    expect(mockCaptureException).toHaveBeenCalled();
  });
});

describe('shared flag cache', () => {
  test('reuses one resolved value for sequential reads inside the TTL', async () => {
    mockGetFeatureFlag.mockResolvedValue(true);

    await expect(isFeatureFlagEnabled('cached-flag', 'user-a')).resolves.toBe(true);
    await expect(isFeatureFlagEnabled('cached-flag', 'user-a')).resolves.toBe(true);
    await expect(isFeatureFlagEnabled('cached-flag', 'user-a')).resolves.toBe(true);

    expect(mockGetFeatureFlag).toHaveBeenCalledTimes(1);
  });

  test('reads PostHog again once the cached value is older than the TTL', async () => {
    jest.useFakeTimers();
    mockGetFeatureFlag.mockResolvedValue(true);

    await isFeatureFlagEnabled('expiring-flag', 'user-b');
    jest.setSystemTime(Date.now() + 29_999);
    await isFeatureFlagEnabled('expiring-flag', 'user-b');
    expect(mockGetFeatureFlag).toHaveBeenCalledTimes(1);

    jest.setSystemTime(Date.now() + 1);
    await isFeatureFlagEnabled('expiring-flag', 'user-b');
    expect(mockGetFeatureFlag).toHaveBeenCalledTimes(2);
  });

  test('shares one read between concurrent callers of the same key', async () => {
    const read = Promise.withResolvers<unknown>();
    mockGetFeatureFlag.mockReturnValue(read.promise);

    const first = isFeatureFlagEnabled('deduped-flag', 'user-c');
    const second = isFeatureFlagEnabled('deduped-flag', 'user-c');
    read.resolve(true);

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(mockGetFeatureFlag).toHaveBeenCalledTimes(1);
  });

  test('keeps distinct ids and person properties in separate cache entries', async () => {
    mockGetFeatureFlag.mockResolvedValue(true);

    await isFeatureFlagEnabled('scoped-flag', 'user-d');
    await isFeatureFlagEnabled('scoped-flag', 'user-e');
    await isReleaseToggleEnabled('scoped-flag', 'user-d', { plan: 'team' });
    await isReleaseToggleEnabled('scoped-flag', 'user-d', { plan: 'enterprise' });

    expect(mockGetFeatureFlag).toHaveBeenCalledTimes(4);
  });

  test('applies the caller default when PostHog does not answer within the deadline', async () => {
    jest.useFakeTimers();
    mockGetFeatureFlag.mockReturnValue(new Promise(() => {}));

    const read = isReleaseToggleEnabled('slow-flag', 'user-f');
    await jest.advanceTimersByTimeAsync(1_000);

    await expect(read).resolves.toBe(false);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('did not answer') }),
      expect.objectContaining({
        tags: { source: 'posthog_feature_flag_boolean_enabled' },
      })
    );
  });

  test('reports one deadline failure per window and reads again after it', async () => {
    jest.useFakeTimers();
    mockGetFeatureFlag.mockReturnValue(new Promise(() => {}));

    const first = isReleaseToggleEnabled('stalled-flag', 'user-g');
    await jest.advanceTimersByTimeAsync(1_000);
    await first;

    const second = isReleaseToggleEnabled('stalled-flag', 'user-g');
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(second).resolves.toBe(false);
    expect(mockGetFeatureFlag).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);

    jest.setSystemTime(Date.now() + 30_001);
    const third = isFeatureFlagEnabled('stalled-flag', 'user-g');
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(third).resolves.toBe(false);
    expect(mockGetFeatureFlag).toHaveBeenCalledTimes(2);
  });

  test('masks a key for the 10 s first-miss window instead of 30 s', async () => {
    jest.useFakeTimers();
    mockGetFeatureFlag.mockReturnValue(new Promise(() => {}));

    const first = isReleaseToggleEnabled('first-miss-flag', 'user-h');
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(first).resolves.toBe(false);
    const missedAt = Date.now();
    expect(mockGetFeatureFlag).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);

    jest.setSystemTime(missedAt + 9_999);
    await expect(isReleaseToggleEnabled('first-miss-flag', 'user-h')).resolves.toBe(false);
    expect(mockGetFeatureFlag).toHaveBeenCalledTimes(1);

    jest.setSystemTime(missedAt + 10_001);
    const afterWindow = isReleaseToggleEnabled('first-miss-flag', 'user-h');
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(afterWindow).resolves.toBe(false);
    expect(mockGetFeatureFlag).toHaveBeenCalledTimes(2);
  });

  test('opens the 30 s window after a second consecutive miss', async () => {
    jest.useFakeTimers();
    mockGetFeatureFlag.mockReturnValue(new Promise(() => {}));

    const first = isReleaseToggleEnabled('stalled-twice-flag', 'user-i');
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(first).resolves.toBe(false);
    const firstMissAt = Date.now();
    expect(mockGetFeatureFlag).toHaveBeenCalledTimes(1);

    // The read after the first window misses too, which opens the longer window.
    jest.setSystemTime(firstMissAt + 10_001);
    const second = isReleaseToggleEnabled('stalled-twice-flag', 'user-i');
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(second).resolves.toBe(false);
    const secondMissAt = Date.now();
    expect(mockGetFeatureFlag).toHaveBeenCalledTimes(2);

    jest.setSystemTime(secondMissAt + 29_000);
    await expect(isReleaseToggleEnabled('stalled-twice-flag', 'user-i')).resolves.toBe(false);
    expect(mockGetFeatureFlag).toHaveBeenCalledTimes(2);
    // The second miss falls inside the flag name's report window, so only the
    // first miss reported; the cache backoff still keeps the second miss.
    expect(mockCaptureException).toHaveBeenCalledTimes(1);

    jest.setSystemTime(secondMissAt + 30_001);
    const third = isReleaseToggleEnabled('stalled-twice-flag', 'user-i');
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(third).resolves.toBe(false);
    expect(mockGetFeatureFlag).toHaveBeenCalledTimes(3);
  });

  test('resets the miss count after a successful read', async () => {
    jest.useFakeTimers();
    mockGetFeatureFlag.mockReturnValue(new Promise(() => {}));

    const first = isReleaseToggleEnabled('recovering-flag', 'user-j');
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(first).resolves.toBe(false);
    const firstMissAt = Date.now();

    // The read after the first window succeeds, so the streak ends here.
    jest.setSystemTime(firstMissAt + 10_001);
    mockGetFeatureFlag.mockResolvedValueOnce(true);
    await expect(isReleaseToggleEnabled('recovering-flag', 'user-j')).resolves.toBe(true);
    const recoveredAt = Date.now();
    expect(mockGetFeatureFlag).toHaveBeenCalledTimes(2);

    // The resolved value serves its TTL, then the next read misses. That miss
    // starts a new streak, so it masks for 10 s rather than 30 s.
    jest.setSystemTime(recoveredAt + 30_001);
    const nextMiss = isReleaseToggleEnabled('recovering-flag', 'user-j');
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(nextMiss).resolves.toBe(false);
    const missedAt = Date.now();
    expect(mockGetFeatureFlag).toHaveBeenCalledTimes(3);

    jest.setSystemTime(missedAt + 9_999);
    await expect(isReleaseToggleEnabled('recovering-flag', 'user-j')).resolves.toBe(false);
    expect(mockGetFeatureFlag).toHaveBeenCalledTimes(3);

    jest.setSystemTime(missedAt + 10_001);
    const afterWindow = isReleaseToggleEnabled('recovering-flag', 'user-j');
    await jest.advanceTimersByTimeAsync(1_000);
    await expect(afterWindow).resolves.toBe(false);
    expect(mockGetFeatureFlag).toHaveBeenCalledTimes(4);
  });

  test('evicts a settled key before the oldest in-flight read', async () => {
    const pinned = Promise.withResolvers<unknown>();
    mockGetFeatureFlag.mockReturnValueOnce(pinned.promise);
    mockGetFeatureFlag.mockResolvedValue(true);

    const pinnedFirst = isFeatureFlagEnabled('pinned-flag', 'user-pinned');
    for (let index = 0; index < 500; index++) {
      await isFeatureFlagEnabled('burst-flag', `user-${index}`);
    }

    const pinnedSecond = isFeatureFlagEnabled('pinned-flag', 'user-pinned');
    pinned.resolve(true);

    await expect(Promise.all([pinnedFirst, pinnedSecond])).resolves.toEqual([true, true]);
    expect(mockGetFeatureFlag).toHaveBeenCalledTimes(501);
  });

  test('evicts the least recently used key so the cache stays bounded', async () => {
    mockGetFeatureFlag.mockResolvedValue(true);

    for (let index = 0; index < 501; index++) {
      await isFeatureFlagEnabled('bounded-flag', `user-${index}`);
    }
    expect(mockGetFeatureFlag).toHaveBeenCalledTimes(501);

    await isFeatureFlagEnabled('bounded-flag', 'user-0');
    expect(mockGetFeatureFlag).toHaveBeenCalledTimes(502);
  });
});

describe('failure report throttle', () => {
  // These cases leave fake timers installed; the suite's afterAll hook needs
  // real ones to run its shutdown.
  afterEach(() => {
    jest.useRealTimers();
  });

  test('reports one failure for two distinct ids of the same flag in one window', async () => {
    jest.useFakeTimers();
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mockGetFeatureFlag.mockReturnValue(new Promise(() => {}));

      const first = isReleaseToggleEnabled('survey-credits', 'user-one');
      await jest.advanceTimersByTimeAsync(1_000);
      await expect(first).resolves.toBe(false);

      // A different distinct id is a different cache key, so it reads and misses
      // on its own, but it must not add a second report for the same flag name.
      const second = isReleaseToggleEnabled('survey-credits', 'user-two');
      await jest.advanceTimersByTimeAsync(1_000);
      await expect(second).resolves.toBe(false);

      expect(mockGetFeatureFlag).toHaveBeenCalledTimes(2);
      expect(mockCaptureException).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith(
        'Error checking boolean feature flag:',
        'survey-credits',
        expect.objectContaining({ message: expect.stringContaining('did not answer') })
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  test('reports each flag name independently', async () => {
    jest.useFakeTimers();
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mockGetFeatureFlag.mockReturnValue(new Promise(() => {}));

      const first = isReleaseToggleEnabled('survey-credits', 'user-one');
      await jest.advanceTimersByTimeAsync(1_000);
      await expect(first).resolves.toBe(false);

      const second = isReleaseToggleEnabled('cloud-data-export-ui', 'user-two');
      await jest.advanceTimersByTimeAsync(1_000);
      await expect(second).resolves.toBe(false);

      expect(mockGetFeatureFlag).toHaveBeenCalledTimes(2);
      expect(mockCaptureException).toHaveBeenCalledTimes(2);
      expect(consoleError).toHaveBeenCalledTimes(2);
      expect(consoleError).toHaveBeenNthCalledWith(
        2,
        'Error checking boolean feature flag:',
        'cloud-data-export-ui',
        expect.anything()
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  test('reports the same flag name again once its window has passed', async () => {
    jest.useFakeTimers();
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      mockGetFeatureFlag.mockReturnValue(new Promise(() => {}));

      const first = isReleaseToggleEnabled('survey-credits', 'user-one');
      await jest.advanceTimersByTimeAsync(1_000);
      await expect(first).resolves.toBe(false);
      const firstReportedAt = Date.now();
      expect(mockCaptureException).toHaveBeenCalledTimes(1);

      jest.setSystemTime(firstReportedAt + 30_001);
      const afterWindow = isReleaseToggleEnabled('survey-credits', 'user-three');
      await jest.advanceTimersByTimeAsync(1_000);
      await expect(afterWindow).resolves.toBe(false);

      expect(mockCaptureException).toHaveBeenCalledTimes(2);
      expect(consoleError).toHaveBeenCalledTimes(2);
    } finally {
      consoleError.mockRestore();
    }
  });
});
