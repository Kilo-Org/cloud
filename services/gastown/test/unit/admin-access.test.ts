import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import type { GastownEnv } from '../../src/gastown.worker';
import { adminAuditMiddleware } from '../../src/middleware/admin-audit.middleware';

// Minimal env stub for tests
function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: 'test',
    GASTOWN_AE: {
      writeDataPoint: vi.fn(),
    },
    ...overrides,
  } as unknown as Env;
}

describe('adminAuditMiddleware', () => {
  function createApp() {
    const app = new Hono<GastownEnv>();
    // Set up auth context variables before the audit middleware runs.
    // In production, kiloAuthMiddleware does this.
    app.use('/api/towns/:townId/*', async (c, next) => {
      // Simulates kiloAuthMiddleware + resolveWorkerAdminMiddleware.
      const isAdmin = c.req.header('X-Test-Is-Admin') === 'true';
      const capability = c.req.header('X-Test-Capability') === 'true';
      const userId = c.req.header('X-Test-User-Id') ?? 'unknown';
      c.set('kiloIsAdmin', isAdmin);
      c.set('kiloUserId', userId);
      c.set(
        'workerAdmin',
        capability
          ? ({
              legacyClaim: false,
              hasCapability: true,
              capabilityError: null,
              mode: 'reject',
              decide: async () => ({
                allowed: true,
                source: 'capability',
                wouldDeny: false,
                jti: 'jti-1',
                reason: 'granted',
              }),
            } as never)
          : ({
              legacyClaim: isAdmin,
              hasCapability: false,
              capabilityError: null,
              mode: 'honor',
              decide: async () => ({
                allowed: true,
                source: 'legacy',
                wouldDeny: false,
                jti: null,
                reason: 'honored',
              }),
            } as never)
      );
      return next();
    });
    app.use('/api/towns/:townId/*', adminAuditMiddleware);
    app.get('/api/towns/:townId/config', c => c.json({ ok: true, townId: c.req.param('townId') }));
    return app;
  }

  it('does not log for non-admin requests', async () => {
    const app = createApp();
    const env = testEnv();
    const res = await app.request(
      'http://localhost/api/towns/town-123/config',
      {
        headers: {
          'X-Test-Is-Admin': 'false',
          'X-Test-User-Id': 'user-1',
        },
      },
      env
    );
    expect(res.status).toBe(200);
    // @ts-expect-error -- mock function
    expect(env.GASTOWN_AE.writeDataPoint).not.toHaveBeenCalled();
  });

  it('logs admin access with correct event data', async () => {
    const app = createApp();
    const env = testEnv();
    const res = await app.request(
      'http://localhost/api/towns/town-456/config',
      {
        headers: {
          'X-Test-Is-Admin': 'true',
          'X-Test-User-Id': 'admin-user-1',
        },
      },
      env
    );
    expect(res.status).toBe(200);
    // @ts-expect-error -- mock function
    const writeDataPoint = env.GASTOWN_AE.writeDataPoint;
    expect(writeDataPoint).toHaveBeenCalledOnce();

    const call = writeDataPoint.mock.calls[0][0];
    // blob1 = event name
    expect(call.blobs[0]).toBe('admin.legacy_claim');
    // blob2 = userId
    expect(call.blobs[1]).toBe('admin-user-1');
    // blob3 = delivery
    expect(call.blobs[2]).toBe('http');
    // blob4 = capability action id
    expect(call.blobs[3]).toBe('rest:GET /api/towns/:townId/config');
    // blob6 = townId
    expect(call.blobs[5]).toBe('town-456');
  });

  it('logs capability access when a capability is present', async () => {
    const app = createApp();
    const env = testEnv();
    const res = await app.request(
      'http://localhost/api/towns/town-789/config',
      {
        headers: {
          'X-Test-Capability': 'true',
          'X-Test-User-Id': 'admin-user-3',
        },
      },
      env
    );
    expect(res.status).toBe(200);
    // @ts-expect-error -- mock function
    const writeDataPoint = env.GASTOWN_AE.writeDataPoint;
    expect(writeDataPoint).toHaveBeenCalledOnce();
    const call = writeDataPoint.mock.calls[0][0];
    expect(call.blobs[0]).toBe('admin.capability');
    expect(call.blobs[1]).toBe('admin-user-3');
    expect(call.blobs[9]).toBe('jti-1');
  });

  it('passes through to the handler after logging', async () => {
    const app = createApp();
    const env = testEnv();
    const res = await app.request(
      'http://localhost/api/towns/my-town/config',
      {
        headers: {
          'X-Test-Is-Admin': 'true',
          'X-Test-User-Id': 'admin-user-2',
        },
      },
      env
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, townId: 'my-town' });
  });
});

// NOTE: Tests for townAuthMiddleware admin bypass require the Cloudflare
// workers runtime (cloudflare:workers) and must be run in the integration
// test environment (pnpm test:integration).
