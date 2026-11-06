import { afterEach, expect, test } from '@jest/globals';

jest.mock('@kilocode/web-shared/lib/posthog', () => {
  const mockGetFeatureFlag = jest.fn();
  return {
    __esModule: true,
    default: () => ({ getFeatureFlag: mockGetFeatureFlag }),
    mockGetFeatureFlag,
  };
});
jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  startSpan: async (_context: unknown, run: () => Promise<unknown>) => run(),
}));

import { isClaudePlatformOAuthEnabled } from './feature-flag.server';

const { mockGetFeatureFlag }: { mockGetFeatureFlag: jest.Mock } = jest.requireMock(
  '@kilocode/web-shared/lib/posthog'
);

afterEach(() => {
  jest.restoreAllMocks();
});

test('refreshes launch changes and closes on missing or failed evaluation in development', async () => {
  jest.replaceProperty(process, 'env', { ...process.env, NODE_ENV: 'development' });
  const clock = jest.spyOn(Date, 'now').mockReturnValue(0);
  jest.spyOn(console, 'error').mockImplementation(() => {});
  mockGetFeatureFlag
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true)
    .mockRejectedValueOnce(new Error('Flag service unavailable'));

  await expect(isClaudePlatformOAuthEnabled()).resolves.toBe(false);
  clock.mockReturnValue(30_000);
  await expect(isClaudePlatformOAuthEnabled()).resolves.toBe(true);
  clock.mockReturnValue(60_000);
  await expect(isClaudePlatformOAuthEnabled()).resolves.toBe(false);
  clock.mockReturnValue(90_000);
  await expect(isClaudePlatformOAuthEnabled()).resolves.toBe(true);
  clock.mockReturnValue(120_000);
  await expect(isClaudePlatformOAuthEnabled()).resolves.toBe(false);
});
