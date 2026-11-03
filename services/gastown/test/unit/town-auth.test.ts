import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GastownEnv } from '../../src/gastown.worker';

const getTownConfig = vi.fn();
vi.mock('../../src/dos/Town.do', () => ({
  getTownDOStub: () => ({ getTownConfig }),
}));
vi.mock('../../src/middleware/worker-admin.middleware', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../src/middleware/worker-admin.middleware')>();
  return { ...actual, emitWorkerAdminDecision: vi.fn() };
});

import { emitWorkerAdminDecision } from '../../src/middleware/worker-admin.middleware';
import { townAuthMiddleware } from '../../src/middleware/town-auth.middleware';

type Decision = { allowed: boolean; status?: number; reason?: string };

function app(params: {
  userId: string;
  memberships?: Array<{ orgId: string; role: string }>;
  decision: Decision;
  hasCapability?: boolean;
  legacyClaim?: boolean;
}) {
  const decide = vi.fn(async () => ({
    allowed: params.decision.allowed,
    source: 'legacy',
    wouldDeny: false,
    jti: null,
    reason: params.decision.allowed ? 'honored' : 'legacy_claim_rejected',
    status: params.decision.status,
  }));
  const app = new Hono<GastownEnv>();
  app.use('*', async (c, next) => {
    c.set('kiloUserId', params.userId);
    c.set('kiloTokenClaims', { isAdmin: true, iat: 1, exp: 3601 });
    c.set('kiloOrgMemberships', params.memberships ?? []);
    c.set('workerAdmin', {
      decide,
      hasCapability: params.hasCapability ?? true,
      legacyClaim: params.legacyClaim ?? false,
    } as never);
    return next();
  });
  app.use('/api/towns/:townId/*', townAuthMiddleware);
  app.use('/api/users/:userId/towns/:townId/*', townAuthMiddleware);
  app.get('/api/towns/:townId/config', c => c.json({ ok: true }));
  app.get('/api/users/:userId/towns/:townId/events', c => c.json({ ok: true }));
  return { app, decide };
}

function config(owner: Record<string, unknown>) {
  getTownConfig.mockResolvedValue(owner);
}

const town = '00000000-0000-4000-8000-000000000001';

beforeEach(() => {
  getTownConfig.mockReset();
  vi.mocked(emitWorkerAdminDecision).mockClear();
});

describe('townAuthMiddleware', () => {
  it('checks ownership before consulting the admin authority', async () => {
    config({ owner_type: 'user', owner_user_id: 'user-1' });
    const { app: a, decide } = app({ userId: 'user-1', decision: { allowed: true } });
    expect(
      (await a.request(`http://localhost/api/towns/${town}/config`, {}, {} as never)).status
    ).toBe(200);
    expect(decide).not.toHaveBeenCalled();
    expect(emitWorkerAdminDecision).not.toHaveBeenCalled();
  });

  it('lets an org member through without an admin decision', async () => {
    config({ owner_type: 'org', organization_id: 'org-1' });
    const { app: a, decide } = app({
      userId: 'user-1',
      memberships: [{ orgId: 'org-1', role: 'member' }],
      decision: { allowed: false },
    });
    expect(
      (await a.request(`http://localhost/api/towns/${town}/config`, {}, {} as never)).status
    ).toBe(200);
    expect(decide).not.toHaveBeenCalled();
  });

  it('allows a foreign town through a granted bypass and audits it', async () => {
    config({ owner_type: 'user', owner_user_id: 'user-2' });
    const { app: a } = app({ userId: 'user-1', decision: { allowed: true } });
    expect(
      (await a.request(`http://localhost/api/towns/${town}/config`, {}, {} as never)).status
    ).toBe(200);
    expect(emitWorkerAdminDecision).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ allowed: true }),
      expect.objectContaining({ townId: town })
    );
  });

  it('denies a foreign town and audits the denial', async () => {
    config({ owner_type: 'user', owner_user_id: 'user-2' });
    const { app: a } = app({
      userId: 'user-1',
      decision: { allowed: false, status: 403 },
    });
    expect(
      (await a.request(`http://localhost/api/towns/${town}/config`, {}, {} as never)).status
    ).toBe(403);
    expect(emitWorkerAdminDecision).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ allowed: false }),
      expect.objectContaining({ townId: town })
    );
  });

  it('derives a user target for user-scoped events routes', async () => {
    config({ owner_type: 'user', owner_user_id: 'user-target' });
    const { app: a, decide } = app({ userId: 'admin-1', decision: { allowed: true } });
    const response = await a.request(
      `http://localhost/api/users/user-target/towns/${town}/events`,
      {},
      {} as never
    );
    expect(response.status).toBe(200);
    expect(decide).toHaveBeenCalledWith('rest:GET /api/users/:userId/towns/:townId/events', {
      kind: 'user',
      id: 'user-target',
    });
  });

  it('lets an org member read an org town through the user route', async () => {
    config({ owner_type: 'org', organization_id: 'org-1' });
    const { app: a, decide } = app({
      userId: 'member-1',
      memberships: [{ orgId: 'org-1', role: 'member' }],
      decision: { allowed: false },
    });
    const response = await a.request(
      `http://localhost/api/users/member-1/towns/${town}/events`,
      {},
      {} as never
    );
    expect(response.status).toBe(200);
    expect(decide).not.toHaveBeenCalled();
  });

  it("rejects a user-target capability for another user's town", async () => {
    config({ owner_type: 'user', owner_user_id: 'owner-2' });
    const { app: a, decide } = app({ userId: 'admin-1', decision: { allowed: true } });
    const response = await a.request(
      `http://localhost/api/users/user-target/towns/${town}/events`,
      {},
      {} as never
    );
    expect(response.status).toBe(403);
    expect(decide).not.toHaveBeenCalled();
    expect(emitWorkerAdminDecision).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ allowed: false, reason: 'target_mismatch' }),
      expect.objectContaining({ townId: town })
    );
  });

  it('rejects a user-target capability for an org-owned town', async () => {
    config({ owner_type: 'org', organization_id: 'org-1' });
    const { app: a, decide } = app({ userId: 'admin-1', decision: { allowed: true } });
    const response = await a.request(
      `http://localhost/api/users/user-target/towns/${town}/events`,
      {},
      {} as never
    );
    expect(response.status).toBe(403);
    expect(decide).not.toHaveBeenCalled();
  });

  it('restores admin bypass for a town with no owner id', async () => {
    config({ owner_type: 'user', owner_user_id: null });
    const { app: a } = app({ userId: 'user-1', decision: { allowed: true } });
    expect(
      (await a.request(`http://localhost/api/towns/${town}/config`, {}, {} as never)).status
    ).toBe(200);
  });

  it('keeps 404 for a town with no owner when no bypass applies', async () => {
    config({ owner_type: 'user', owner_user_id: null });
    const { app: a } = app({
      userId: 'user-1',
      decision: { allowed: false, status: 403 },
    });
    expect(
      (await a.request(`http://localhost/api/towns/${town}/config`, {}, {} as never)).status
    ).toBe(404);
  });

  it('returns 503 when capability validation is unavailable', async () => {
    config({ owner_type: 'user', owner_user_id: 'user-2' });
    const { app: a } = app({
      userId: 'user-1',
      decision: { allowed: false, status: 503 },
    });
    expect(
      (await a.request(`http://localhost/api/towns/${town}/config`, {}, {} as never)).status
    ).toBe(503);
  });

  it('restores admin bypass when town config cannot be loaded', async () => {
    getTownConfig.mockRejectedValue(new Error('missing'));
    const { app: a } = app({ userId: 'user-1', decision: { allowed: true } });
    expect(
      (await a.request(`http://localhost/api/towns/${town}/config`, {}, {} as never)).status
    ).toBe(200);
  });
});
