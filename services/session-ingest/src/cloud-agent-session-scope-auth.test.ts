import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObject {},
  WorkerEntrypoint: class WorkerEntrypoint {},
}));

vi.mock('./middleware/kilo-jwt-auth', () => ({
  kiloJwtAuthMiddleware: async (
    c: {
      req: { header(name: string): string | undefined };
      set(name: string, value: string): void;
    },
    next: () => Promise<void>
  ) => {
    if (c.req.header('Authorization') !== 'Bearer valid-user-token') {
      return new Response('Unauthorized', { status: 401 });
    }
    c.set('user_id', 'usr_from_jwt');
    await next();
  },
}));

vi.mock('./routes/cloud-agent-session-scope', async () => {
  const cloudAgentSessionScopeApi = new Hono();
  cloudAgentSessionScopeApi.post('/session', c => c.body(null, 204));
  return { cloudAgentSessionScopeApi };
});

vi.mock('@kilocode/db/client', () => ({ getWorkerDb: vi.fn() }));
vi.mock('./dos/SessionIngestDO', () => ({ getSessionIngestDO: vi.fn() }));
vi.mock('./dos/SessionAccessCacheDO', () => ({ getSessionAccessCacheDO: vi.fn() }));

const { app } = await import('./app');

const env = {
  INTERNAL_API_SECRET_PROD: { get: async () => 'valid-internal-secret' },
} as never;

describe('Cloud Agent session scope internal authentication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects an internal-secret-only request', async () => {
    const response = await app.request(
      '/internal/cloud-agent/v1/session',
      {
        method: 'POST',
        headers: { 'X-Internal-Secret': 'valid-internal-secret' },
      },
      env
    );

    expect(response.status).toBe(401);
  });

  it('rejects a JWT-only request', async () => {
    const response = await app.request(
      '/internal/cloud-agent/v1/session',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer valid-user-token' },
      },
      env
    );

    expect(response.status).toBe(401);
  });

  it('requires both JWT and internal secret before dispatching', async () => {
    const response = await app.request(
      '/internal/cloud-agent/v1/session',
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer valid-user-token',
          'X-Internal-Secret': 'valid-internal-secret',
        },
      },
      env
    );

    expect(response.status).toBe(204);
  });
});
