import { beforeEach, describe, expect, test } from '@jest/globals';

jest.mock('@/lib/posthog', () => {
  const mockGetFeatureFlag = jest.fn();
  const mockGetFeatureFlagPayload = jest.fn();

  return {
    __esModule: true,
    default: jest.fn(() => ({
      getFeatureFlag: mockGetFeatureFlag,
      getFeatureFlagPayload: mockGetFeatureFlagPayload,
    })),
    shutdownPosthog: jest.fn(),
    mockGetFeatureFlag,
    mockGetFeatureFlagPayload,
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
  isFeatureFlagEnabledOrDevelopment,
  isReleaseToggleEnabled,
  isOrganizationAllowlistedForIsolateReviews,
} from '@/lib/posthog-feature-flags';

const posthogMock: {
  mockGetFeatureFlag: jest.Mock;
  mockGetFeatureFlagPayload: jest.Mock;
} = jest.requireMock('@/lib/posthog');

const sentryMock: {
  mockCaptureException: jest.Mock;
} = jest.requireMock('@sentry/nextjs');

const { mockGetFeatureFlag, mockGetFeatureFlagPayload } = posthogMock;
const { mockCaptureException } = sentryMock;

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
      expect(mockGetFeatureFlag).toHaveBeenCalledWith('cloud-agent-devcontainer', 'user-2');
    } finally {
      replacedEnv.restore();
    }
  });
});

describe('isOrganizationAllowlistedForIsolateReviews', () => {
  const organizationId = '3d4a1f18-69cc-44ba-971e-04e9d9784e03';

  beforeEach(() => {
    jest.resetAllMocks();
    const { startSpan } = jest.requireMock('@sentry/nextjs');
    startSpan.mockImplementation((_context: unknown, run: () => Promise<unknown>) => run());
  });

  test('uses a strict boolean and its corresponding payload without development bypass', async () => {
    mockGetFeatureFlag.mockResolvedValue(true);
    mockGetFeatureFlagPayload.mockResolvedValue({ organizationIds: [organizationId] });
    await expect(isOrganizationAllowlistedForIsolateReviews(organizationId)).resolves.toBe(true);
    expect(mockGetFeatureFlagPayload).toHaveBeenCalledWith(
      'code-review-isolate-organizations',
      organizationId,
      true
    );
    mockGetFeatureFlagPayload.mockResolvedValue({
      organizationIds: [organizationId.toUpperCase()],
    });
    await expect(isOrganizationAllowlistedForIsolateReviews(organizationId)).resolves.toBe(false);
  });

  test('rejects malformed payloads atomically and never reports their contents', async () => {
    mockGetFeatureFlag.mockResolvedValue(true);
    mockGetFeatureFlagPayload.mockResolvedValue({
      organizationIds: [organizationId, 'private-value'],
    });
    await expect(isOrganizationAllowlistedForIsolateReviews(organizationId)).resolves.toBe(false);
    expect(mockCaptureException).not.toHaveBeenCalled();
    mockGetFeatureFlagPayload.mockRejectedValue(new Error('private-payload-and-credentials'));
    await expect(isOrganizationAllowlistedForIsolateReviews(organizationId)).resolves.toBe(false);
    expect(mockCaptureException).toHaveBeenCalledWith(
      new Error('Isolate review rollout lookup failed'),
      {
        tags: { source: 'posthog_feature_flag_boolean_enabled' },
        extra: { flagName: 'code-review-isolate-organizations' },
      }
    );
  });

  test('rejects an oversized allowlist', async () => {
    mockGetFeatureFlag.mockResolvedValue(true);
    mockGetFeatureFlagPayload.mockResolvedValue({
      organizationIds: Array(10_001).fill(organizationId),
    });
    await expect(isOrganizationAllowlistedForIsolateReviews(organizationId)).resolves.toBe(false);
  });
});

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
