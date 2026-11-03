import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const mockReadDb = {
  select: jest.fn(),
};
const limitMock = jest.fn<() => Promise<unknown>>();

jest.mock('@kilocode/web-shared/lib/drizzle', () => ({ readDb: mockReadDb }));

import { defineTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import type * as InitModule from './init';

type Ping = (headersList?: Headers) => Promise<string>;

// The min-version cache is module state, so each test runs against a fresh
// module registry.
let ping: Ping;

function mobileHeaders(version: string): Headers {
  return new Headers({
    'x-kilo-client': 'mobile',
    'x-kilo-app-platform': 'android',
    'x-kilo-app-version': version,
  });
}

/** The tRPC code a client receives for this error. */
function errorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return undefined;
}

/** The `upstreamCode` the error formatter derives from this error's cause. */
function upstreamCode(error: unknown): unknown {
  if (!error || typeof error !== 'object' || !('cause' in error)) {
    return undefined;
  }
  const cause = error.cause;
  if (!cause || typeof cause !== 'object' || !('upstreamCode' in cause)) {
    return undefined;
  }
  return cause.upstreamCode;
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  mockReadDb.select.mockReturnValue({ from: jest.fn().mockReturnValue({ limit: limitMock }) });

  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const init = require('./init') as typeof InitModule;
  const router = init.createTRPCRouter({ ping: init.baseProcedure.query(() => 'ok') });
  const createCaller = init.createCallerFactory(router);
  ping = headersList => createCaller({ user: defineTestUser(), headersList }).ping();
});

describe('minimumVersionMiddleware', () => {
  test('answers a failed read with a retryable error, not an app-update verdict', async () => {
    limitMock.mockRejectedValue(new Error('db down'));

    const error = await ping(mobileHeaders('1.0.5')).catch((caught: unknown) => caught);

    expect(errorCode(error)).toBe('SERVICE_UNAVAILABLE');
    expect(upstreamCode(error)).toBeUndefined();
  });

  test('refuses a version below the configured minimum with the app-update verdict', async () => {
    limitMock.mockResolvedValue([{ ios: '9.9.9', android: '9.9.9' }]);

    const error = await ping(mobileHeaders('1.0.5')).catch((caught: unknown) => caught);

    expect(errorCode(error)).toBe('FORBIDDEN');
    expect(upstreamCode(error)).toBe('app_update_required');
  });

  test('passes a version at the configured minimum', async () => {
    limitMock.mockResolvedValue([{ ios: '1.0.4', android: '1.0.5' }]);

    await expect(ping(mobileHeaders('1.0.5'))).resolves.toBe('ok');
  });

  test('shares one read between concurrent mobile callers', async () => {
    limitMock.mockResolvedValue([{ ios: '1.0.4', android: '1.0.5' }]);

    await expect(
      Promise.all([ping(mobileHeaders('1.0.5')), ping(mobileHeaders('1.0.5'))])
    ).resolves.toEqual(['ok', 'ok']);

    expect(limitMock).toHaveBeenCalledTimes(1);
  });

  test('skips the read for a non-mobile caller', async () => {
    await expect(ping(new Headers({ 'x-kilo-app-version': '1.0.5' }))).resolves.toBe('ok');

    expect(limitMock).not.toHaveBeenCalled();
  });
});
