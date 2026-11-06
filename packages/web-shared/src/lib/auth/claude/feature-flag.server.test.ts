import { afterEach, beforeEach, expect, test } from '@jest/globals';

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

beforeEach(() => {
  mockGetFeatureFlag.mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('evaluates each person with an explicit email property without sharing results', async () => {
  mockGetFeatureFlag.mockImplementation(async (_flag, email) => email === 'employee@kilocode.ai');

  await expect(isClaudePlatformOAuthEnabled('employee@kilocode.ai')).resolves.toBe(true);
  await expect(isClaudePlatformOAuthEnabled('customer@example.com')).resolves.toBe(false);
  await expect(isClaudePlatformOAuthEnabled('employee@kilocode.ai')).resolves.toBe(true);
  expect(mockGetFeatureFlag.mock.calls).toEqual([
    [
      'claude-platform-oauth',
      'employee@kilocode.ai',
      { personProperties: { email: 'employee@kilocode.ai' } },
    ],
    [
      'claude-platform-oauth',
      'customer@example.com',
      { personProperties: { email: 'customer@example.com' } },
    ],
    [
      'claude-platform-oauth',
      'employee@kilocode.ai',
      { personProperties: { email: 'employee@kilocode.ai' } },
    ],
  ]);
});

test.each([false, undefined, null, 'true', 'enabled'])(
  'requires boolean true rather than %s, including in development',
  async value => {
    jest.replaceProperty(process, 'env', { ...process.env, NODE_ENV: 'development' });
    mockGetFeatureFlag.mockResolvedValue(value);
    await expect(isClaudePlatformOAuthEnabled('employee@kilocode.ai')).resolves.toBe(false);
  }
);

test.each([undefined, null, '', '   '])(
  'refuses missing email %s without evaluating',
  async email => {
    mockGetFeatureFlag.mockResolvedValue(true);
    await expect(isClaudePlatformOAuthEnabled(email)).resolves.toBe(false);
    expect(mockGetFeatureFlag).not.toHaveBeenCalled();
  }
);

test('normalizes the email used for person targeting', async () => {
  mockGetFeatureFlag.mockResolvedValue(true);
  await expect(isClaudePlatformOAuthEnabled(' Employee@KiloCode.ai ')).resolves.toBe(true);
  expect(mockGetFeatureFlag).toHaveBeenCalledWith('claude-platform-oauth', 'employee@kilocode.ai', {
    personProperties: { email: 'employee@kilocode.ai' },
  });
});

test('fails closed on an evaluation error without retaining an earlier allowance', async () => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  mockGetFeatureFlag
    .mockResolvedValueOnce(true)
    .mockRejectedValueOnce(new Error('Flag service unavailable'));
  await expect(isClaudePlatformOAuthEnabled('employee@kilocode.ai')).resolves.toBe(true);
  await expect(isClaudePlatformOAuthEnabled('employee@kilocode.ai')).resolves.toBe(false);
});
