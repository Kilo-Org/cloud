import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { HonoContext } from '../hono-context.js';
import type { Env } from '../types.js';

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  stop: vi.fn(),
  stopBeforeRegistration: vi.fn(),
  start: vi.fn(),
  schedule: vi.fn(),
  source: vi.fn(),
}));
vi.mock('../sandbox-session/session-stub.js', () => ({
  getSandboxSessionStub: () => ({
    getMaintenanceStatus: mocks.status,
    stop: mocks.stop,
    stopMaintenanceBeforeRegistration: mocks.stopBeforeRegistration,
  }),
}));
vi.mock('../utils/do-retry.js', () => ({
  withDORetry: async (getStub: () => unknown, operation: (stub: unknown) => Promise<unknown>) =>
    operation(getStub()),
}));
vi.mock('../db/pg.js', () => ({ getPgDb: () => ({}) }));
vi.mock('../router/handlers/session-worktree.js', () => ({
  loadWorkspaceSource: mocks.source,
  sourceWorktreeBranchName: () => 'feature',
}));
vi.mock('./start.js', () => ({
  maintenanceContext: () => ({}),
  startMaintenanceChat: mocks.start,
}));
vi.mock('./scheduling.js', () => ({ scheduleMaintenance: mocks.schedule }));
import { registerMaintenanceRoutes } from './routes.js';

const env = { INTERNAL_API_SECRET: 'synthetic-internal-secret' } as Env;
const owner = {
  userId: 'oauth/synthetic-owner',
  cloudAgentSessionId: 'workspace_11111111-1111-4111-8111-111111111111',
  messageId: 'msg_018f1e2d3c4bAbCdEfGhIjKlMn',
};
const emptyStatus = {
  message: null,
  latestMessage: null,
  waitingForInput: false,
  stoppedAt: null,
  result: null,
  publication: null,
};
function request(action: string, body: unknown, key = env.INTERNAL_API_SECRET) {
  const app = new Hono<HonoContext>();
  registerMaintenanceRoutes(app);
  return app.request(
    `/internal/pr-maintenance/${action}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { 'x-internal-api-key': key } : {}),
      },
      body: JSON.stringify(body),
    },
    env
  );
}
beforeEach(() => {
  vi.resetAllMocks();
});

describe('internal maintenance routes', () => {
  it('authenticates before reading or dispatching maintenance work', async () => {
    expect((await request('status', owner, 'wrong-key')).status).toBe(401);
    expect(mocks.status).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('cannot stop an ordinary user chat through the maintenance endpoint', async () => {
    mocks.status.mockResolvedValue(null);
    const response = await request('stop', owner);
    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
    expect(mocks.stop).not.toHaveBeenCalled();
  });

  it('writes a bound Stop before slow registration completes', async () => {
    mocks.status.mockResolvedValue(null);
    mocks.stopBeforeRegistration.mockResolvedValue({ stopped: true });
    const identity = {
      watchId: '22222222-2222-4222-8222-222222222222',
      attemptId: '33333333-3333-4333-8333-333333333333',
    };
    const response = await request('stop', { ...owner, ...identity });
    expect(response.status).toBe(200);
    expect(mocks.stopBeforeRegistration).toHaveBeenCalledWith({
      ...identity,
      messageId: owner.messageId,
    });
  });

  it('returns the durable stop marker after stopping a waiting maintenance chat', async () => {
    mocks.status
      .mockResolvedValueOnce({ ...emptyStatus, waitingForInput: true })
      .mockResolvedValueOnce({ ...emptyStatus, stoppedAt: 1000 });
    const response = await request('stop', owner);
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(await response.json()).toMatchObject({ stoppedAt: 1000 });
  });

  it('rejects malformed identities without calling a session', async () => {
    expect(
      (await request('status', { ...owner, cloudAgentSessionId: 'agent_legacy' })).status
    ).toBe(400);
    expect(mocks.status).not.toHaveBeenCalled();
  });

  it('returns inherited execution choices without runtime credentials', async () => {
    mocks.source.mockResolvedValue({
      worktreeId: 'worktree_22222222-2222-4222-8222-222222222222',
      repository: { type: 'github', repo: 'example/repository' },
      ownership: {
        kiloSessionId: 'ses_fixture',
        cloudAgentSessionId: owner.cloudAgentSessionId,
        profileId: null,
      },
      metadata: {
        agent: { model: 'kilo/fake-deterministic', variant: 'high' },
        auth: { kilocodeToken: 'must-not-escape' },
        initialMessage: { prompt: 'Fix the synthetic issue.' },
      },
    });
    const response = await request('workspace', {
      userId: owner.userId,
      worktreeId: 'worktree_22222222-2222-4222-8222-222222222222',
    });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(JSON.parse(body)).toMatchObject({
      repoUrl: 'https://github.com/example/repository',
      headRef: 'feature',
      model: 'kilo/fake-deterministic',
      variant: 'high',
      purpose: 'Fix the synthetic issue.',
    });
    expect(body).not.toContain('must-not-escape');
  });
});
