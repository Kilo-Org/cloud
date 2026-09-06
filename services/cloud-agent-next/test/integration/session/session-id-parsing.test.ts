/**
 * Integration test for DO name → sessionId parsing.
 *
 * Ensures that userIds containing colons (e.g. "oauth/google:12345") don't
 * break the session-id extraction in the CloudAgentSession constructor.
 */

import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, it, expect } from 'vitest';
import { groupedRegisterSessionInput } from '../../helpers/session-setup.js';

// Registered sessions leave dispatch, alarm, and fire-and-forget publication
// work in the session DO. Interrupt every session a test touched, clear its
// alarm, and drain its publication tail, or that work wakes after this file
// closes and its logs race the vitest worker shutdown as pending
// onUserConsoleLog rejections (EnvironmentTeardownError).
const touchedSessions = new Set<string>();

function sessionStub(userId: string, sessionId: string) {
  const sessionName = `${userId}:${sessionId}`;
  touchedSessions.add(sessionName);
  return env.CLOUD_AGENT_SESSION.get(env.CLOUD_AGENT_SESSION.idFromName(sessionName));
}

afterEach(async () => {
  for (const sessionName of touchedSessions) {
    await runInDurableObject(
      env.CLOUD_AGENT_SESSION.get(env.CLOUD_AGENT_SESSION.idFromName(sessionName)),
      async (instance, state) => {
        try {
          await instance.interruptExecution();
        } catch {
          // A session that never registered has no work to interrupt.
        }
        await state.storage.deleteAlarm();
        const publicationTail = (instance as any).publicExtensionPublicationTail as
          | Promise<unknown>
          | undefined;
        await publicationTail?.catch(() => undefined);
      }
    ).catch(() => undefined);
  }
  touchedSessions.clear();
});

describe('CloudAgentSession sessionId parsing from DO name', () => {
  it('extracts sessionId correctly when userId contains a colon (OAuth provider)', async () => {
    const userId = 'oauth/google:103883072551006019454';
    const sessionId = 'agent_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const stub = sessionStub(userId, sessionId);

    const result = await runInDurableObject(stub, async instance => {
      return instance.registerSession(
        groupedRegisterSessionInput({
          sessionId,
          userId,
          kiloSessionId: 'kilo_test_session',
          prompt: 'test prompt',
          mode: 'code',
          model: 'test-model',
        })
      );
    });

    expect(result.success).toBe(true);
  });

  it('extracts sessionId correctly when userId has no colon', async () => {
    const userId = 'user_simple';
    const sessionId = 'agent_11111111-2222-3333-4444-555555555555';
    const stub = sessionStub(userId, sessionId);

    const result = await runInDurableObject(stub, async instance => {
      return instance.registerSession(
        groupedRegisterSessionInput({
          sessionId,
          userId,
          kiloSessionId: 'kilo_test_session',
          prompt: 'test prompt',
          mode: 'code',
          model: 'test-model',
        })
      );
    });

    expect(result.success).toBe(true);
  });

  it('stores the correct sessionId in metadata (not the userId fragment)', async () => {
    const userId = 'oauth/github:99999';
    const sessionId = 'agent_metadata-check';
    const stub = sessionStub(userId, sessionId);

    const metadata = await runInDurableObject(stub, async instance => {
      await instance.registerSession(
        groupedRegisterSessionInput({
          sessionId,
          userId,
          kiloSessionId: 'kilo_test_session',
          prompt: 'test prompt',
          mode: 'code',
          model: 'test-model',
        })
      );
      return instance.getMetadata();
    });

    // The stored sessionId must be the agent session ID, not the OAuth numeric ID
    expect(metadata?.identity.sessionId).toBe(sessionId);
    expect(metadata?.identity.sessionId).not.toBe('99999');
  });
});
