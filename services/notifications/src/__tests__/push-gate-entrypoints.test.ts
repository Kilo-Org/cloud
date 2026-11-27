import { createExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchPushInput } from '@kilocode/notifications';
import * as dbClient from '@kilocode/db/client';

import { NotificationsService } from '../index';

const TEST_INTERNAL_SECRET = 'test-internal-api-secret';
const DB_REQUESTED = 'database client requested';
const PRODUCTION_DATABASE = { HYPERDRIVE: { connectionString: 'postgres://test' } };

const CLOUD_AGENT_PUSH = {
  userId: 'user-a',
  cliSessionId: 'ses_1',
  executionId: 'exec_1',
  status: 'completed' as const,
  body: 'Done',
};
const AGENT_PUSH = {
  userId: 'user-a',
  cliSessionId: 'ses_1',
  notificationId: 'note_1',
  message: 'Please look',
};
const LOW_BALANCE = {
  kind: 'low_balance',
  recipientUserIds: ['user-a', 'user-b', 'user-a'],
  organizationId: 'org_1',
  organizationName: 'Org',
  minimumBalanceUsd: 5,
};

// The staging env has no database binding, so any use of one throws. The user
// DO is a recorder, so these tests observe only what the entrypoints do.
function setupService(workerEnv: 'staging' | 'production', vars: Record<string, unknown> = {}) {
  const dispatched: DispatchPushInput[] = [];
  const refreshed: unknown[] = [];
  const serviceEnv = {
    WORKER_ENV: workerEnv,
    // Production keeps its binding so the open path reaches the client factory.
    ...(workerEnv === 'production' ? PRODUCTION_DATABASE : {}),
    INTERNAL_API_SECRET: { get: async () => TEST_INTERNAL_SECRET },
    ...vars,
    NOTIFICATION_CHANNEL_DO: {
      idFromName: (userId: string) => userId,
      get: () => ({
        dispatchPush: async (input: DispatchPushInput) => {
          dispatched.push(input);
          return { kind: 'no_tokens' };
        },
        refreshGlanceableSnapshot: async (scope: unknown) => {
          refreshed.push(scope);
        },
      }),
    },
  };
  const service = new NotificationsService(createExecutionContext(), serviceEnv as never);
  const postDispatch = (body: unknown) =>
    service.fetch(
      new Request('https://example.com/internal/v1/dispatch', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Internal-Secret': TEST_INTERNAL_SECRET,
        },
        body: JSON.stringify(body),
      })
    );
  return { service, postDispatch, dispatched, refreshed };
}

describe('push entrypoints under the staging push gate', () => {
  let dbSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    dbSpy = vi.spyOn(dbClient, 'getWorkerDb').mockImplementation(() => {
      throw new Error(DB_REQUESTED);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers the session send RPCs with no delivery and no database read', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { service, dispatched } = setupService('staging');

    const cloudAgent = await service.sendCloudAgentSessionNotification(CLOUD_AGENT_PUSH);
    const sessionReady = await service.sendSessionReadyNotification({
      userId: 'user-a',
      cliSessionId: 'ses_1',
    });
    const agent = await service.sendAgentSessionNotification(AGENT_PUSH);

    expect(cloudAgent).toEqual({ dispatched: false });
    expect(sessionReady).toEqual({ dispatched: false });
    expect(agent).toEqual({ dispatched: false, reason: 'no_tokens' });
    expect(log).toHaveBeenCalledWith({
      event: 'agent_push_outcome',
      cliSessionId: 'ses_1',
      notificationId: 'note_1',
      outcome: 'no_tokens',
    });
    expect(log).toHaveBeenCalledWith('notifications_push_disabled', {
      surface: 'push_entrypoint',
    });
    expect(dbSpy).not.toHaveBeenCalled();
    expect(dispatched).toEqual([]);
  });

  it('still rejects malformed send input while the gate is closed', async () => {
    const { service } = setupService('staging');

    await expect(
      service.sendCloudAgentSessionNotification({ ...CLOUD_AGENT_PUSH, userId: '' })
    ).rejects.toThrow();
    expect(dbSpy).not.toHaveBeenCalled();
  });

  it('refreshes no glanceable scope and reads no session row', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { service, refreshed } = setupService('staging');

    await service.refreshGlanceableSessions({
      userId: 'user-a',
      cliSessionIds: ['ses_1'],
      cardFollowSessionIds: ['ses_1'],
    });

    expect(refreshed).toEqual([]);
    expect(dbSpy).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('notifications_push_disabled', {
      surface: 'glanceable_refresh',
    });
  });

  it('opens no STS bundle from the push RPCs under the STS source', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const getBundle = vi.fn(async () => {
      throw new Error('a gated RPC must not open the STS bundle');
    });
    const { service, dispatched, refreshed } = setupService('staging', {
      SECRETS_SOURCE: 'sts',
      STS: { getBundle },
    });

    await service.sendCloudAgentSessionNotification(CLOUD_AGENT_PUSH);
    await service.sendSessionReadyNotification({ userId: 'user-a', cliSessionId: 'ses_1' });
    await service.sendAgentSessionNotification(AGENT_PUSH);
    await service.refreshGlanceableSessions({ userId: 'user-a', cliSessionIds: ['ses_1'] });

    expect(getBundle).not.toHaveBeenCalled();
    expect(dbSpy).not.toHaveBeenCalled();
    expect(dispatched).toEqual([]);
    expect(refreshed).toEqual([]);
  });

  it('answers internal dispatch per unique recipient through the user DO with no database', async () => {
    const { postDispatch, dispatched } = setupService('staging');

    const res = await postDispatch(LOW_BALANCE);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      perRecipient: [
        { userId: 'user-a', outcome: 'no_tokens' },
        { userId: 'user-b', outcome: 'no_tokens' },
      ],
    });
    expect(dispatched.map(input => input.userId)).toEqual(['user-a', 'user-b']);
    expect(dbSpy).not.toHaveBeenCalled();
  });

  it('keeps the database path for every entrypoint in production', async () => {
    const { service, postDispatch, dispatched, refreshed } = setupService('production');

    await expect(service.sendCloudAgentSessionNotification(CLOUD_AGENT_PUSH)).rejects.toThrow(
      DB_REQUESTED
    );
    await expect(
      service.sendSessionReadyNotification({ userId: 'user-a', cliSessionId: 'ses_1' })
    ).rejects.toThrow(DB_REQUESTED);
    await expect(service.sendAgentSessionNotification(AGENT_PUSH)).rejects.toThrow(DB_REQUESTED);
    await expect(
      service.refreshGlanceableSessions({ userId: 'user-a', cliSessionIds: ['ses_1'] })
    ).rejects.toThrow(DB_REQUESTED);
    const res = await postDispatch(LOW_BALANCE);

    expect(res.status).toBe(500);
    expect(dbSpy).toHaveBeenCalledTimes(5);
    expect(dispatched).toEqual([]);
    expect(refreshed).toEqual([]);
  });
});
