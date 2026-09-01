import { afterEach, expect, it, jest } from '@jest/globals';
import { initTRPC, TRPCError } from '@trpc/server';

jest.mock('@/lib/trpc/init', () => ({
  createTRPCContext: () => ({}),
}));

jest.mock('@/routers/root-router', () => {
  const t = initTRPC.create();
  return {
    rootRouter: t.router({
      ok: t.procedure.query(() => 'ok'),
      fail: t.procedure.query(() => {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'SYNTHETIC_SENSITIVE_TOKEN',
        });
      }),
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
