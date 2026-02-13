import { beforeEach, describe, expect, test } from '@jest/globals';

jest.mock('@/lib/posthog', () => {
  const mockGetFeatureFlag = jest.fn();

  return {
    __esModule: true,
    default: jest.fn(() => ({
      getFeatureFlag: mockGetFeatureFlag,
      getFeatureFlagPayload: jest.fn(),
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

import { isReleaseToggleEnabled } from '@/lib/posthog-feature-flags';

const posthogMock: {
  mockGetFeatureFlag: jest.Mock;
} = jest.requireMock('@/lib/posthog');

const sentryMock: {
  mockCaptureException: jest.Mock;
} = jest.requireMock('@sentry/nextjs');

const { mockGetFeatureFlag } = posthogMock;
const { mockCaptureException } = sentryMock;

describe('isReleaseToggleEnabled', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns true only when PostHog flag value is boolean true', async () => {
    mockGetFeatureFlag.mockResolvedValueOnce(true);

    await expect(isReleaseToggleEnabled('kiloclaw', 'user-1')).resolves.toBe(true);
    expect(mockGetFeatureFlag).toHaveBeenCalledWith('kiloclaw', 'user-1');
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
