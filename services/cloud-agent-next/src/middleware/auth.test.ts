import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HonoContext } from '../hono-context.js';
import type { Env } from '../types.js';

vi.mock('../auth.js', () => ({
  validateKiloToken: vi.fn(),
}));

vi.mock('../logger.js', () => {
  const logger = {
    setTags: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withFields: vi.fn(),
  };
  logger.withFields.mockReturnValue(logger);
  return {
    logger,
    withLogTags: async (_tags: unknown, fn: () => Promise<unknown>) => fn(),
    WithLogTags:
      () =>
      (
        _target: unknown,
        _propertyKey: string,
        descriptor: PropertyDescriptor
      ): PropertyDescriptor =>
        descriptor,
  };
});

const { authMiddleware } = await import('./auth.js');
const { validateKiloToken } = await import('../auth.js');

describe('authMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateKiloToken).mockResolvedValue({ success: false, error: 'Invalid token' });
  });

  it('returns a non-retryable unauthorized client error without changing message or path', async () => {
    const app = new Hono<HonoContext>();
    app.use('/trpc/*', authMiddleware);
    app.post('/trpc/:procedure', c => c.json({ ok: true }));

    const response = await app.fetch(
      new Request('https://worker.test/trpc/send', { method: 'POST' }),
      { NEXTAUTH_SECRET: 'secret' } as Env
    );
    const body: any = await response.json();

    expect(response.status).toBe(401);
    expect(body.error.message).toBe('Invalid token');
    expect(body.error.data).toMatchObject({
      path: 'send',
      clientError: {
        code: 'UNAUTHORIZED',
        message: 'Invalid token',
        retryable: false,
      },
    });
  });
});
