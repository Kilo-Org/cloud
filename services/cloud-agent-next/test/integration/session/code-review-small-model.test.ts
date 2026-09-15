import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { registerReadySession } from '../../helpers/session-setup.js';

describe('code-review small model metadata', () => {
  it('persists agent.smallModel through registerSession', async () => {
    const userId = 'user_small_model';
    const sessionId = 'agent_small_model';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        prompt: 'Review the PR',
        mode: 'code',
        model: 'anthropic/claude-sonnet-4.6',
        smallModel: 'anthropic/claude-haiku-4.5',
        createdOnPlatform: 'code-review',
        kilocodeToken: 'token-small-model',
      });

      const metadata = await instance.getMetadata();
      expect(metadata?.agent?.smallModel).toBe('anthropic/claude-haiku-4.5');
      expect(metadata?.agent?.model).toBe('anthropic/claude-sonnet-4.6');
    });
  });

  it('omits agent.smallModel when the caller does not provide one', async () => {
    const userId = 'user_small_model_none';
    const sessionId = 'agent_small_model_none';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId,
        prompt: 'Do the work',
        mode: 'code',
        model: 'anthropic/claude-sonnet-4.6',
        createdOnPlatform: 'cloud-agent-web',
        kilocodeToken: 'token-small-model-none',
      });

      const metadata = await instance.getMetadata();
      expect(metadata?.agent?.smallModel).toBeUndefined();
    });
  });
});
