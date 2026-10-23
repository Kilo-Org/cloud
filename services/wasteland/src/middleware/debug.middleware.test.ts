import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { Hono } from 'hono';
import type { AccessPayload } from '@kilocode/worker-utils/cf-access';
import type { WastelandEnv } from '../wasteland.worker';
import { logger } from '../util/log.util';
import {
  authorizeDebugUserAction,
  debugAccessMiddleware,
  debugOperatorFromAccessPayload,
  debugRoutesEnabled,
  parseDebugOperatorAllowlist,
} from './debug.middleware';

const cfAccess = vi.hoisted(() => ({ validate: vi.fn() }));

vi.mock('@kilocode/worker-utils/cf-access', () => ({
  validateCfAccessRequest: cfAccess.validate,
}));

const wasteland = vi.hoisted(() => ({
  getWastelandDOStub: vi.fn(),
}));

vi.mock('../dos/Wasteland.do', () => ({
  getWastelandDOStub: wasteland.getWastelandDOStub,
}));

const WASTELAND_ID = 'wl-1';
const OWNER_ID = 'user-owner';
const MEMBER_ID = 'user-member';
const OUTSIDER_ID = 'user-outsider';

type EnvOverrides = {
  ENVIRONMENT?: 'development' | 'production';
  WASTELAND_DEBUG_ROUTES?: string;
  WASTELAND_DEBUG_OPERATORS?: string;
};

function testEnv(overrides: EnvOverrides = {}) {
  return {
    ENVIRONMENT: overrides.ENVIRONMENT ?? 'production',
    WASTELAND_DEBUG_ROUTES: overrides.WASTELAND_DEBUG_ROUTES ?? 'enabled',
    WASTELAND_DEBUG_OPERATORS: overrides.WASTELAND_DEBUG_OPERATORS ?? 'ops@example.com',
    CF_ACCESS_TEAM: 'engineering-e11',
    CF_ACCESS_AUD: '7f6eda4c0714f6ea2afb74a3f055db65659b67571a913eab42463636a9b8c8be',
  };
}

function userPayload(email: string): AccessPayload {
  return {
    type: 'app',
    aud: ['7f6eda4c0714f6ea2afb74a3f055db65659b67571a913eab42463636a9b8c8be'],
    exp: 2_000_000_000,
    iat: 1_700_000_000,
    iss: 'https://engineering-e11.cloudflareaccess.com',
    nbf: 1_700_000_000,
    email,
    identity_nonce: 'nonce',
    sub: '0f3c1f9e-8ad4-4a4f-8f0e-0b9a3a4c5d6e',
    country: 'RS',
  };
}

function servicePayload(commonName: string): AccessPayload {
  return {
    type: 'app',
    aud: '7f6eda4c0714f6ea2afb74a3f055db65659b67571a913eab42463636a9b8c8be',
    exp: 2_000_000_000,
    iat: 1_700_000_000,
    iss: 'https://engineering-e11.cloudflareaccess.com',
    common_name: commonName,
    sub: '',
    identity_nonce: undefined,
  };
}

function createApp() {
  const app = new Hono<WastelandEnv>();
  app.use('/debug/*', debugAccessMiddleware);
  app.get('/debug/probe', c => c.json({ ok: true, operator: c.get('debugOperator') }));
  app.get('/debug/wastelands/:wastelandId/browse', async c => {
    const userId = c.req.query('userId') ?? '';
    const denied = await authorizeDebugUserAction(c, {
      wastelandId: c.req.param('wastelandId'),
      userId,
      operation: 'wanted.browse',
    });
    if (denied) return denied;
    return c.json({ ok: true, userId });
  });
  app.notFound(c => c.json({ error: 'Not found' }, 404));
  return app;
}

function withConfig(config: { owner_user_id: string | null } | null) {
  wasteland.getWastelandDOStub.mockReturnValue({
    getConfig: async () => config,
    listMembers: async () => [
      { member_id: 'm-1', user_id: MEMBER_ID, role: 'contributor', trust_level: 1 },
    ],
  });
}

describe('debug surface helpers', () => {
  it('serves the tree only when the flag is exactly enabled', () => {
    expect(debugRoutesEnabled({ WASTELAND_DEBUG_ROUTES: 'enabled' })).toBe(true);
    expect(debugRoutesEnabled({ WASTELAND_DEBUG_ROUTES: 'disabled' })).toBe(false);
    expect(debugRoutesEnabled({ WASTELAND_DEBUG_ROUTES: 'ENABLED' })).toBe(false);
    expect(debugRoutesEnabled({})).toBe(false);
  });

  it('parses a case-insensitive operator allowlist and admits nobody when empty', () => {
    expect([...parseDebugOperatorAllowlist(' Ops@Example.com , svc.access ')]).toEqual([
      'ops@example.com',
      'svc.access',
    ]);
    expect(parseDebugOperatorAllowlist('').size).toBe(0);
    expect(parseDebugOperatorAllowlist(undefined).size).toBe(0);
    expect(parseDebugOperatorAllowlist(' , ').size).toBe(0);
  });

  it('derives the operator identity from a user or a service-token payload', () => {
    expect(debugOperatorFromAccessPayload(userPayload('Ops@Example.com'))).toEqual({
      kind: 'user',
      id: 'ops@example.com',
    });
    expect(debugOperatorFromAccessPayload(servicePayload('abc123.access'))).toEqual({
      kind: 'service-token',
      id: 'abc123.access',
    });
  });
});

describe('debugAccessMiddleware', () => {
  let audit: MockInstance;

  beforeEach(() => {
    cfAccess.validate.mockReset();
    wasteland.getWastelandDOStub.mockReset();
    audit = vi.spyOn(logger, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers 404 for the whole tree when the deployment does not enable it', async () => {
    cfAccess.validate.mockResolvedValue(userPayload('ops@example.com'));
    const response = await createApp().request(
      '/debug/probe',
      {},
      testEnv({ WASTELAND_DEBUG_ROUTES: 'disabled' }) as never
    );

    expect(response.status).toBe(404);
    expect(cfAccess.validate).not.toHaveBeenCalled();
  });

  it('does not enable the tree in a development deployment without the flag', async () => {
    const response = await createApp().request(
      '/debug/probe',
      {},
      testEnv({ ENVIRONMENT: 'development', WASTELAND_DEBUG_ROUTES: 'disabled' }) as never
    );

    expect(response.status).toBe(404);
  });

  it('serves local development with the flag and records the local operator', async () => {
    const response = await createApp().request(
      '/debug/probe',
      {},
      testEnv({ ENVIRONMENT: 'development' }) as never
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      operator: { kind: 'local-development', id: 'local-development' },
    });
    expect(audit).toHaveBeenCalledWith(
      'debug.access',
      expect.objectContaining({
        operator: 'local-development:local-development',
        method: 'GET',
        path: '/debug/probe',
      })
    );
  });

  it('rejects a deployed request without a valid Access assertion', async () => {
    cfAccess.validate.mockRejectedValue(new Error('Missing CF Access JWT'));
    const response = await createApp().request('/debug/probe', {}, testEnv() as never);

    expect(response.status).toBe(401);
    expect(audit).not.toHaveBeenCalledWith('debug.access', expect.anything());
  });

  it('rejects a deployed request whose operator is not listed', async () => {
    cfAccess.validate.mockResolvedValue(userPayload('someone-else@example.com'));
    const response = await createApp().request('/debug/probe', {}, testEnv() as never);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ success: false, error: 'Forbidden' });
    expect(audit).not.toHaveBeenCalledWith('debug.access', expect.anything());
  });

  it('admits a listed user operator case-insensitively and audits the identity', async () => {
    cfAccess.validate.mockResolvedValue(userPayload('OPS@example.com'));
    const response = await createApp().request(
      '/debug/probe',
      {},
      testEnv({ WASTELAND_DEBUG_OPERATORS: 'other@example.com, ops@example.com' }) as never
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      operator: { kind: 'user', id: 'ops@example.com' },
    });
    expect(audit).toHaveBeenCalledWith(
      'debug.access',
      expect.objectContaining({ operator: 'user:ops@example.com', path: '/debug/probe' })
    );
  });

  it('admits a listed service-token operator', async () => {
    cfAccess.validate.mockResolvedValue(servicePayload('abc123.access'));
    const response = await createApp().request(
      '/debug/probe',
      {},
      testEnv({ WASTELAND_DEBUG_OPERATORS: 'abc123.access' }) as never
    );

    expect(response.status).toBe(200);
  });

  it('denies a deployed request when the allowlist is empty', async () => {
    cfAccess.validate.mockResolvedValue(userPayload('ops@example.com'));
    const response = await createApp().request(
      '/debug/probe',
      {},
      testEnv({ WASTELAND_DEBUG_OPERATORS: '' }) as never
    );

    expect(response.status).toBe(403);
  });
});

describe('authorizeDebugUserAction', () => {
  let audit: MockInstance;
  let auditWarn: MockInstance;

  beforeEach(() => {
    cfAccess.validate.mockReset();
    wasteland.getWastelandDOStub.mockReset();
    audit = vi.spyOn(logger, 'info').mockImplementation(() => {});
    auditWarn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('admits the wasteland owner and audits the operator, wasteland, user and operation', async () => {
    withConfig({ owner_user_id: OWNER_ID });
    const response = await createApp().request(
      `/debug/wastelands/${WASTELAND_ID}/browse?userId=${OWNER_ID}`,
      {},
      testEnv({ ENVIRONMENT: 'development' }) as never
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, userId: OWNER_ID });
    expect(audit).toHaveBeenCalledWith(
      'debug.action',
      expect.objectContaining({
        operator: 'local-development:local-development',
        wastelandId: WASTELAND_ID,
        userId: OWNER_ID,
        operation: 'wanted.browse',
      })
    );
  });

  it('admits a member of the wasteland', async () => {
    withConfig({ owner_user_id: OWNER_ID });
    const response = await createApp().request(
      `/debug/wastelands/${WASTELAND_ID}/browse?userId=${MEMBER_ID}`,
      {},
      testEnv({ ENVIRONMENT: 'development' }) as never
    );

    expect(response.status).toBe(200);
  });

  it('rejects a user that does not belong to the wasteland before the handler runs', async () => {
    withConfig({ owner_user_id: OWNER_ID });
    const response = await createApp().request(
      `/debug/wastelands/${WASTELAND_ID}/browse?userId=${OUTSIDER_ID}`,
      {},
      testEnv({ ENVIRONMENT: 'development' }) as never
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'User does not belong to this wasteland',
    });
    expect(auditWarn).toHaveBeenCalledWith(
      'debug.action forbidden',
      expect.objectContaining({
        wastelandId: WASTELAND_ID,
        userId: OUTSIDER_ID,
        operation: 'wanted.browse',
      })
    );
    expect(audit).not.toHaveBeenCalledWith('debug.action', expect.anything());
  });

  it('answers 404 when the wasteland does not exist', async () => {
    withConfig(null);
    const response = await createApp().request(
      `/debug/wastelands/${WASTELAND_ID}/browse?userId=${OWNER_ID}`,
      {},
      testEnv({ ENVIRONMENT: 'development' }) as never
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Wasteland not found' });
  });
});
