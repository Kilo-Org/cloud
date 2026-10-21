import { encodeCloudAgentRootSessionsCursor } from '@kilocode/session-ingest-contracts';
import { describe, expect, it, vi } from 'vitest';
import type { Env, TRPCContext } from '../../types.js';
import { router } from '../auth.js';
import { listHostedSessions } from './hosted-session-list.js';

const userId = 'oauth/google:hosted-session-owner';
const sessionId = 'ses_12345678901234567890123456';
const cursor = encodeCloudAgentRootSessionsCursor({
  updatedAt: '2026-10-18 22:31:14.123456+00',
  sessionId,
});

function fixture() {
  const listCloudAgentRootSessions = vi.fn(async () => ({
    items: [
      {
        kiloSessionId: sessionId,
        cloudAgentSessionId: 'workspace_11111111-1111-4111-8111-111111111111',
        userId: 'untrusted-service-owner',
        organizationId: null,
        title: 'Hosted session',
        gitUrl: 'https://github.com/kilo-org/cloud',
        gitBranch: 'feature/hosted-session-list',
        profileId: '22222222-2222-4222-8222-222222222222',
        createdOnPlatform: 'cloud-agent-web',
        created: 1_760_000_000_000,
        updated: 1_760_000_001_000,
      },
    ],
    nextCursor: cursor,
  }));
  const durableObjectAccess = vi.fn(() => {
    throw new Error('Hosted session discovery must not access Durable Objects');
  });
  const ctx = {
    env: {
      SESSION_INGEST: { listCloudAgentRootSessions },
      CLOUD_AGENT_SESSION: { idFromName: durableObjectAccess, get: durableObjectAccess },
      SANDBOX_SESSION: { idFromName: durableObjectAccess, get: durableObjectAccess },
    } as unknown as Env,
    userId,
    authToken: 'authenticated-user-token',
    request: new Request('https://worker.test/trpc/listHostedSessions'),
  } satisfies TRPCContext;
  return {
    caller: router({ listHostedSessions }).createCaller(ctx),
    listCloudAgentRootSessions,
    durableObjectAccess,
  };
}

describe('listHostedSessions', () => {
  it('projects only the authenticated user into passive paginated discovery', async () => {
    const test = fixture();

    await expect(test.caller.listHostedSessions({ limit: 25, cursor })).resolves.toMatchObject({
      items: [{ kiloSessionId: sessionId, userId }],
      nextCursor: cursor,
    });
    expect(test.listCloudAgentRootSessions).toHaveBeenCalledWith({
      kiloUserId: userId,
      limit: 25,
      cursor,
    });
    expect(test.durableObjectAccess).not.toHaveBeenCalled();
  });

  it('rejects a client-supplied owner and invalid cursor before calling session ingest', async () => {
    const test = fixture();

    await expect(
      test.caller.listHostedSessions({ limit: 25, cursor: 'not-a-cursor', userId } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(test.listCloudAgentRootSessions).not.toHaveBeenCalled();
    expect(test.durableObjectAccess).not.toHaveBeenCalled();
  });
});
