import { env } from 'cloudflare:test';
import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import type { AuthContext } from '../auth';
import { botAuthMiddleware } from '../auth-bot';
import { registerBotRoutes } from '../routes/bot-messages';
import { registerSandboxReadRoutes } from '../routes/sandbox-reads';
import { deriveGatewayToken } from '../lib/gateway-token';
import { withTestExecutionCtx } from './helpers';

const ownershipMap = new Map<string, Set<string>>();
const sandboxOwnerMap = new Map<string, string>();

vi.mock('../services/sandbox-ownership', () => ({
  userOwnsSandbox: async (_env: Env, userId: string, sandboxId: string) =>
    ownershipMap.get(userId)?.has(sandboxId) ?? false,
  lookupSandboxOwnerUserId: async (_env: Env, sandboxId: string) =>
    sandboxOwnerMap.get(sandboxId) ?? null,
}));

vi.mock('../services/user-lookup', () => ({
  resolveUserDisplayInfo: async () => new Map(),
  validateUserIds: async (_conn: string, userIds: string[]) => ({
    valid: userIds,
    invalid: [],
  }),
}));

function grantSandbox(userId: string, sandboxId: string) {
  if (!ownershipMap.has(userId)) ownershipMap.set(userId, new Set());
  ownershipMap.get(userId)!.add(sandboxId);
  sandboxOwnerMap.set(sandboxId, userId);
}

const SECRET = 'test-gateway-secret';

function makeEnv(pushEvent?: ReturnType<typeof vi.fn>): Env {
  const baseEnv = {
    ...env,
    GATEWAY_TOKEN_SECRET: { get: () => Promise.resolve(SECRET) },
  } as unknown as Env;
  if (!pushEvent) return baseEnv;
  return {
    ...baseEnv,
    EVENT_SERVICE: {
      fetch: env.EVENT_SERVICE.fetch.bind(env.EVENT_SERVICE),
      connect: env.EVENT_SERVICE.connect.bind(env.EVENT_SERVICE),
      pushEvent,
    } satisfies Env['EVENT_SERVICE'],
  };
}

function makeBotApp() {
  const app = new Hono<{ Bindings: Env; Variables: AuthContext }>();
  app.use('/bot/v1/sandboxes/:sandboxId/*', botAuthMiddleware);
  registerBotRoutes(app);
  return withTestExecutionCtx(app);
}

function makeReadAppAs(userId: string) {
  const app = new Hono<{ Bindings: Env; Variables: AuthContext }>();
  app.use('/v1/*', async (c, next) => {
    c.set('callerId', userId);
    c.set('callerKind', 'user');
    await next();
  });
  registerSandboxReadRoutes(app);
  return withTestExecutionCtx(app);
}

async function tokenFor(sandboxId: string): Promise<string> {
  return deriveGatewayToken(sandboxId, SECRET);
}

describe('bot-status route -> service -> DO -> read end-to-end capabilities', () => {
  it('persists and exposes capabilities through POST then GET', async () => {
    const userId = 'user-caps-e2e';
    const sandboxId = 'sandbox-caps-e2e';
    grantSandbox(userId, sandboxId);

    const pushEvent = vi.fn().mockResolvedValue(true);
    const testEnv = makeEnv(pushEvent);

    const botApp = makeBotApp();
    const token = await tokenFor(sandboxId);

    const postRes = await botApp.request(
      `/bot/v1/sandboxes/${sandboxId}/bot-status`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          online: true,
          at: 1_700_000_000_000,
          capabilities: ['attachments'],
        }),
      },
      testEnv
    );
    expect(postRes.status).toBe(200);

    // Verify event push included capabilities
    expect(pushEvent).toHaveBeenCalledOnce();
    const pushedPayload = pushEvent.mock.calls[0]![3] as { capabilities?: string[] };
    expect(pushedPayload.capabilities).toEqual(['attachments']);

    // GET returns capabilities
    const readApp = makeReadAppAs(userId);
    const getRes = await readApp.request(`/v1/sandboxes/${sandboxId}/bot-status`, {}, testEnv);
    expect(getRes.status).toBe(200);
    const body = await getRes.json<{
      status: { online: boolean; at: number; capabilities?: string[] } | null;
    }>();
    expect(body.status).not.toBeNull();
    expect(body.status!.capabilities).toEqual(['attachments']);
  });
});
