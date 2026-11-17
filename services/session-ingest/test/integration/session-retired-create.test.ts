import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { SessionIngestRPC } from '../../src/session-ingest-rpc';

const kiloUserId = 'usr_retired_create';

describe('createSessionForCloudAgent destination availability', () => {
  it('refuses a session id whose ingest object is not accepting data', async () => {
    const suffix = crypto.randomUUID().replaceAll('-', '');
    const sessionId = `ses_${suffix.slice(0, 26)}`;
    const stub = env.SESSION_INGEST_DO.get(
      env.SESSION_INGEST_DO.idFromName(`${kiloUserId}/${sessionId}`)
    );

    await expect(stub.isDeleted()).resolves.toBe(false);

    // The rollback and worktree-deletion paths tombstone through clear(); an
    // ingest after that point is answered `session_not_found`.
    await stub.clear();
    await expect(stub.isDeleted()).resolves.toBe(true);

    const ctx = createExecutionContext();
    const rpc = new SessionIngestRPC(ctx, env);
    await expect(
      rpc.createSessionForCloudAgent({
        sessionId,
        kiloUserId,
        cloudAgentSessionId: `workspace_${suffix}`,
        createdOnPlatform: 'cloud-agent',
      })
    ).resolves.toEqual({ status: 'rejected', code: 'session_retired' });
    await waitOnExecutionContext(ctx);
  });
});
