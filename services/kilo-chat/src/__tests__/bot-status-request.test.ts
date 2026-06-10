import { env } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { AuthContext } from '../auth';
import { registerSandboxReadRoutes } from '../routes/sandbox-reads';
import { withTestExecutionCtx } from './helpers';
import { isDefiniteUnreachable } from '../services/bot-status-request';

// ── isDefiniteUnreachable unit tests ────────────────────────────────────────

describe('isDefiniteUnreachable', () => {
  it('classifies missing-routing errors as definitive', () => {
    expect(isDefiniteUnreachable(new Error('No routing target for sandbox-foo'))).toBe(true);
    expect(isDefiniteUnreachable(new Error('Instance for sandbox-foo has no sandboxId'))).toBe(
      true
    );
  });

  // Regression: deliverChatWebhook refuses to fetch() against a non-running
  // instance to prevent Fly Proxy autostart on suspended/stopped machines.
  // The classifier must treat that throw as definitive so chat dispatchers
  // immediately publish online: false instead of retrying forever and
  // showing a stale "online" indicator.
  it('classifies non-running instance errors as definitive', () => {
    expect(
      isDefiniteUnreachable(new Error('Instance for sandbox-foo is not running (status=stopped)'))
    ).toBe(true);
    expect(
      isDefiniteUnreachable(
        new Error('Instance for instance abc-123 is not running (status=provisioned)')
      )
    ).toBe(true);
    // The match is on the prefix "is not running" so additional status
    // values introduced later in the worker still classify correctly
    // without requiring a lock-step update here.
    expect(
      isDefiniteUnreachable(
        new Error('Instance for sandbox-foo is not running (status=some_future_state)')
      )
    ).toBe(true);
  });

  it('classifies upstream 4xx as definitive', () => {
    expect(isDefiniteUnreachable(new Error('Webhook forward failed: 401 Unauthorized'))).toBe(true);
    expect(isDefiniteUnreachable(new Error('Webhook forward failed: 404 Not Found'))).toBe(true);
    expect(isDefiniteUnreachable(new Error('Webhook forward failed: 410 Gone'))).toBe(true);
  });

  it('classifies upstream 5xx as transient', () => {
    expect(isDefiniteUnreachable(new Error('Webhook forward failed: 500 Internal'))).toBe(false);
    expect(isDefiniteUnreachable(new Error('Webhook forward failed: 502 Bad Gateway'))).toBe(false);
    expect(isDefiniteUnreachable(new Error('Webhook forward failed: 504 Gateway Timeout'))).toBe(
      false
    );
  });

  it('classifies network/abort errors as transient', () => {
    expect(isDefiniteUnreachable(new Error('fetch failed'))).toBe(false);
    expect(isDefiniteUnreachable(new Error('Aborted'))).toBe(false);
    expect(isDefiniteUnreachable(new TypeError('network error'))).toBe(false);
  });

  it('classifies unknown error shapes as transient', () => {
    expect(isDefiniteUnreachable('plain string')).toBe(false);
    expect(isDefiniteUnreachable(undefined)).toBe(false);
    expect(isDefiniteUnreachable(null)).toBe(false);
  });
});

// ── handleRequestBotStatus decision-table tests ──────────────────────────────
//
// These tests exercise the trust-window decision table via the Hono handler.
// We seed a record with a specific updatedAt by writing directly to the DO's
// storage via putBotStatus (which sets updatedAt = Date.now()), then advance
// fake time so the handler sees the record as older than the dedup/trust window.

type RecordingKiloclaw = typeof env.KILOCLAW & {
  __recordedWebhookCalls(): Promise<Array<Record<string, unknown>>>;
  __clearWebhookCalls(): Promise<void>;
};

const ownershipMap = new Map<string, Set<string>>();
vi.mock('../services/sandbox-ownership', () => ({
  userOwnsSandbox: async (_env: Env, userId: string, sandboxId: string) =>
    ownershipMap.get(userId)?.has(sandboxId) ?? false,
  lookupSandboxOwnerUserId: async (_env: Env, sandboxId: string) =>
    ownershipMap.has(sandboxId) ? sandboxId : null,
}));

function grantSandbox(userId: string, sandboxId: string): void {
  if (!ownershipMap.has(userId)) ownershipMap.set(userId, new Set());
  ownershipMap.get(userId)!.add(sandboxId);
}

function makeAppAs(userId: string) {
  const app = new Hono<{ Bindings: Env; Variables: AuthContext }>();
  app.use('/v1/*', async (c, next) => {
    c.set('callerId', userId);
    c.set('callerKind', 'user');
    await next();
  });
  registerSandboxReadRoutes(app);
  return withTestExecutionCtx(app);
}

describe('handleRequestBotStatus decision table', () => {
  const recordingKiloclaw = env.KILOCLAW as RecordingKiloclaw;

  beforeEach(async () => {
    await recordingKiloclaw.__clearWebhookCalls();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('within dedup window (< 10s): returns cached record, skips webhook', async () => {
    const userId = 'user-dt-dedup';
    const sandboxId = 'sandbox-dt-dedup';
    grantSandbox(userId, sandboxId);

    const testEnv = { ...env } as unknown as Env;
    const stub = testEnv.SANDBOX_STATUS_DO.get(testEnv.SANDBOX_STATUS_DO.idFromName(sandboxId));

    const now = 1_700_000_000_000;
    vi.setSystemTime(now);
    await stub.putBotStatus({ online: true, at: now });

    // Advance time by 5 seconds (within the 10s dedup window)
    vi.setSystemTime(now + 5_000);

    const app = makeAppAs(userId);
    const res = await app.request(
      `/v1/sandboxes/${sandboxId}/request-bot-status`,
      { method: 'POST' },
      testEnv
    );

    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; cached: { online: boolean } | null }>();
    expect(body.ok).toBe(true);
    expect(body.cached).not.toBeNull();
    expect(body.cached!.online).toBe(true);

    const calls = await recordingKiloclaw.__recordedWebhookCalls();
    const myCalls = calls.filter(c => c.targetBotId === `bot:kiloclaw:${sandboxId}`);
    expect(myCalls).toHaveLength(0);
  });

  it('within trust window (10s–90s): returns cached record, fires webhook', async () => {
    const userId = 'user-dt-trust';
    const sandboxId = 'sandbox-dt-trust';
    grantSandbox(userId, sandboxId);

    const testEnv = { ...env } as unknown as Env;
    const stub = testEnv.SANDBOX_STATUS_DO.get(testEnv.SANDBOX_STATUS_DO.idFromName(sandboxId));

    const now = 1_700_000_100_000;
    vi.setSystemTime(now);
    await stub.putBotStatus({ online: true, at: now });

    // Advance time by 30 seconds (within trust window, past dedup window)
    vi.setSystemTime(now + 30_000);

    const app = makeAppAs(userId);
    const res = await app.request(
      `/v1/sandboxes/${sandboxId}/request-bot-status`,
      { method: 'POST' },
      testEnv
    );

    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; cached: { online: boolean } | null }>();
    expect(body.ok).toBe(true);
    expect(body.cached).not.toBeNull();
    expect(body.cached!.online).toBe(true);

    const calls = await recordingKiloclaw.__recordedWebhookCalls();
    const myCalls = calls.filter(c => c.targetBotId === `bot:kiloclaw:${sandboxId}`);
    expect(myCalls).toHaveLength(1);
  });

  it('stale (> 90s): returns cached: null, fires webhook', async () => {
    const userId = 'user-dt-stale';
    const sandboxId = 'sandbox-dt-stale';
    grantSandbox(userId, sandboxId);

    const testEnv = { ...env } as unknown as Env;
    const stub = testEnv.SANDBOX_STATUS_DO.get(testEnv.SANDBOX_STATUS_DO.idFromName(sandboxId));

    const now = 1_700_000_200_000;
    vi.setSystemTime(now);
    await stub.putBotStatus({ online: true, at: now });

    // Advance time by 120 seconds (past the 90s trust window)
    vi.setSystemTime(now + 120_000);

    const app = makeAppAs(userId);
    const res = await app.request(
      `/v1/sandboxes/${sandboxId}/request-bot-status`,
      { method: 'POST' },
      testEnv
    );

    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; cached: unknown }>();
    expect(body.ok).toBe(true);
    expect(body.cached).toBeNull();

    const calls = await recordingKiloclaw.__recordedWebhookCalls();
    const myCalls = calls.filter(c => c.targetBotId === `bot:kiloclaw:${sandboxId}`);
    expect(myCalls).toHaveLength(1);
  });

  it('no cached record: returns cached: null, fires webhook', async () => {
    const userId = 'user-dt-nocache';
    const sandboxId = 'sandbox-dt-nocache';
    grantSandbox(userId, sandboxId);

    const testEnv = { ...env } as unknown as Env;

    const app = makeAppAs(userId);
    const res = await app.request(
      `/v1/sandboxes/${sandboxId}/request-bot-status`,
      { method: 'POST' },
      testEnv
    );

    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; cached: unknown }>();
    expect(body.ok).toBe(true);
    expect(body.cached).toBeNull();

    const calls = await recordingKiloclaw.__recordedWebhookCalls();
    const myCalls = calls.filter(c => c.targetBotId === `bot:kiloclaw:${sandboxId}`);
    expect(myCalls).toHaveLength(1);
  });
});
