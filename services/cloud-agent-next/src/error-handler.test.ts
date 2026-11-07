import { Hono } from 'hono';
import { TRPC_ERROR_CODES_BY_KEY } from '@trpc/server/rpc';
import { describe, expect, it, vi } from 'vitest';
import { createWorkerErrorHandler } from './error-handler.js';

function createApp() {
  const logger = { error: vi.fn() };
  const app = new Hono();
  app.use('*', async () => {
    throw new Error('sensitive failure detail');
  });
  app.get('*', c => c.text('unreachable'));
  app.post('*', c => c.text('unreachable'));
  app.onError(createWorkerErrorHandler(logger));
  return { app, logger };
}

describe('createWorkerErrorHandler', () => {
  it('returns a tRPC error envelope for unhandled errors on /trpc routes', async () => {
    const { app, logger } = createApp();

    const response = await app.request('/trpc/getSession?input=%7B%7D', { method: 'POST' });
    const body: any = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: {
        message: 'Internal server error',
        code: TRPC_ERROR_CODES_BY_KEY.INTERNAL_SERVER_ERROR,
        data: {
          code: 'INTERNAL_SERVER_ERROR',
          httpStatus: 500,
          path: 'getSession',
          clientError: {
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Internal server error',
            retryable: true,
          },
        },
      },
    });
    expect(JSON.stringify(body)).not.toContain('sensitive failure detail');
    expect(logger.error).toHaveBeenCalledWith(
      'Unhandled error',
      expect.objectContaining({ error: 'sensitive failure detail' })
    );
  });

  it('keeps the generic JSON body for non-tRPC routes', async () => {
    const { app, logger } = createApp();

    const response = await app.request('/health');

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
    expect(logger.error).toHaveBeenCalledWith(
      'Unhandled error',
      expect.objectContaining({ error: 'sensitive failure detail' })
    );
  });
});
