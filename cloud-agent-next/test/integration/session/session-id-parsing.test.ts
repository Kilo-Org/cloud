/**
 * Integration test for DO name → sessionId parsing.
 *
 * Ensures that userIds containing colons (e.g. "oauth/google:12345") don't
 * break the session-id extraction in the CloudAgentSession constructor.
 */

import { env, runInDurableObject } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('CloudAgentSession sessionId parsing from DO name', () => {
  it('extracts sessionId correctly when userId contains a colon (OAuth provider)', async () => {
    const userId = 'oauth/google:103883072551006019454';
    const sessionId = 'agent_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      return instance.prepare({
        sessionId,
        userId,
        kiloSessionId: 'kilo_test_session',
        prompt: 'test prompt',
        mode: 'code',
        model: 'test-model',
      });
    });

    expect(result.success).toBe(true);
  });

  it('extracts sessionId correctly when userId has no colon', async () => {
    const userId = 'user_simple';
    const sessionId = 'agent_11111111-2222-3333-4444-555555555555';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const result = await runInDurableObject(stub, async instance => {
      return instance.prepare({
        sessionId,
        userId,
        kiloSessionId: 'kilo_test_session',
        prompt: 'test prompt',
        mode: 'code',
        model: 'test-model',
      });
    });

    expect(result.success).toBe(true);
  });

  it('stores the correct sessionId in metadata (not the userId fragment)', async () => {
    const userId = 'oauth/github:99999';
    const sessionId = 'agent_metadata-check';
    const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
    const stub = env.CLOUD_AGENT_SESSION.get(doId);

    const metadata = await runInDurableObject(stub, async instance => {
      await instance.prepare({
        sessionId,
        userId,
        kiloSessionId: 'kilo_test_session',
        prompt: 'test prompt',
        mode: 'code',
        model: 'test-model',
      });
      return instance.getMetadata();
    });

    // The stored sessionId must be the agent session ID, not the OAuth numeric ID
    expect(metadata?.sessionId).toBe(sessionId);
    expect(metadata?.sessionId).not.toBe('99999');
  });
});
