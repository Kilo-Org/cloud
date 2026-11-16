import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import type * as SessionModule from '@/lib/app-shell/session';
import type * as TrpcRouteModule from './route';
import { shellUser } from '@/tests/helpers/shell-user.helper';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  NEXTAUTH_SECRET: 'synthetic-app-shell-signing-secret',
}));
jest.mock('@/lib/app-shell/session', () => ({
  requireAppShellUser: jest.fn(),
}));
// The root router builds service clients at import time; this suite only needs a
// router that answers one query.
jest.mock('@/routers/root-router', () => {
  const { createTRPCRouter, baseProcedure } = jest.requireActual<
    typeof import('@kilocode/web-shared/lib/trpc/init')
  >('@kilocode/web-shared/lib/trpc/init');
  return {
    rootRouter: createTRPCRouter({
      user: createTRPCRouter({
        getMe: baseProcedure.query(({ ctx }) => ({ id: ctx.user.id })),
      }),
    }),
  };
});

// This repo's transform does not hoist `jest.mock` above the static imports, so
// the mocked module and the module under test are required here.
const { requireAppShellUser } =
  jest.requireMock<typeof SessionModule>('@/lib/app-shell/session');
const { GET } = jest.requireActual<typeof TrpcRouteModule>('./route');

const mockRequireUser = jest.mocked(requireAppShellUser);

function queryRequest(headers: Record<string, string> = {}) {
  return new Request('https://kilo.example/app-shell/api/trpc/user.getMe?batch=1&input=%7B%7D', {
    headers,
  });
}

describe('GET /app-shell/api/trpc', () => {
  beforeEach(() => {
    mockRequireUser.mockClear();
  });

  test('refuses a caller with no shell session', async () => {
    mockRequireUser.mockResolvedValue(null);

    const response = await GET(queryRequest());

    expect(response.status).toBe(401);
  });

  test('refuses a cross-origin caller', async () => {
    mockRequireUser.mockResolvedValue(shellUser('user-1'));

    const response = await GET(queryRequest({ origin: 'https://evil.example' }));

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).not.toBe(500);
    expect(mockRequireUser).not.toHaveBeenCalled();
  });

  test('answers a same-origin query with the shell session user', async () => {
    mockRequireUser.mockResolvedValue(shellUser('user-1'));

    const response = await GET(queryRequest({ origin: 'https://kilo.example' }));

    expect(response.status).toBe(200);
    expect(mockRequireUser).toHaveBeenCalled();
  });
});
