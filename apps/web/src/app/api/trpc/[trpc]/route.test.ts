import { afterEach, expect, it, jest } from '@jest/globals';
import { initTRPC, TRPCError } from '@trpc/server';
import type { SessionCheckUnavailableError as SessionCheckUnavailableErrorClass } from '@kilocode/web-shared/lib/uts-bff/browser-session-config';

jest.mock('@kilocode/web-shared/lib/trpc/init', () => ({
  createTRPCContext: () => ({}),
}));

jest.mock('@/routers/root-router', () => {
  const { SessionCheckUnavailableError } = jest.requireActual<{
    SessionCheckUnavailableError: typeof SessionCheckUnavailableErrorClass;
  }>('@kilocode/web-shared/lib/uts-bff/browser-session-config');
  const t = initTRPC.create();
  const unavailable = (retryAfterSeconds: number | null) =>
    t.procedure.query(() => {
      throw new TRPCError({
        code: 'SERVICE_UNAVAILABLE',
        cause: new SessionCheckUnavailableError(retryAfterSeconds),
      });
    });
  return {
    rootRouter: t.router({
      ok: t.procedure.query(() => 'ok'),
      fail: t.procedure.query(() => {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'SYNTHETIC_SENSITIVE_TOKEN',
        });
      }),
      unavailable: unavailable(7),
      unavailableWithoutHint: unavailable(null),
    }),
  };
});

afterEach(() => {
  jest.restoreAllMocks();
});

it.each(['development', 'production', 'test'] as const)(
  'logs only safe batch error fields in development, with NODE_ENV=%s',
  async nodeEnv => {
    jest.replaceProperty(process, 'env', { ...process.env, NODE_ENV: nodeEnv });
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { GET } = await import('./route');

    const response = await GET(new Request('http://localhost/api/trpc/ok,fail?batch=1'));

    expect(response.status).toBe(207);
    if (nodeEnv === 'development') {
      expect(log.mock.calls).toEqual([['[trpc] query fail failed: BAD_REQUEST']]);
    } else {
      expect(log).not.toHaveBeenCalled();
    }
  }
);

it('an unchecked UTS browser session answers 503 with its Retry-After; nothing else carries one', async () => {
  const { GET } = await import('./route');

  const unavailable = await GET(new Request('http://localhost/api/trpc/unavailable'));
  expect(unavailable.status).toBe(503);
  expect(unavailable.headers.get('Retry-After')).toBe('7');

  const batched = await GET(new Request('http://localhost/api/trpc/ok,unavailable?batch=1'));
  expect(batched.status).toBe(207);
  expect(batched.headers.get('Retry-After')).toBe('7');

  const withoutHint = await GET(new Request('http://localhost/api/trpc/unavailableWithoutHint'));
  expect(withoutHint.status).toBe(503);
  expect(withoutHint.headers.get('Retry-After')).toBeNull();

  const other = await GET(new Request('http://localhost/api/trpc/ok,fail?batch=1'));
  expect(other.status).toBe(207);
  expect(other.headers.get('Retry-After')).toBeNull();
});
