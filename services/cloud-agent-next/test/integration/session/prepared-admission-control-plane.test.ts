/**
 * Retained legacy two-step flow (prepareSession + initiateFromKilocodeSessionV2)
 * on a control-plane session.
 *
 * services/code-review-infra still chains the two calls, and wrangler dev
 * defaults CONTROL_PLANE_IDS=* (ENVIRONMENT.md), so a manual review is
 * registered as a `workspace_` session on SandboxSession. The legacy DO admits
 * the stored prepared initial turn via CloudAgentSession.admitPreparedInitialMessage;
 * the control-plane DO must do the same, or every code review fails with
 * "Prepared admission is legacy-only" before a transcript exists.
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';

const userId = 'oauth/google:prepared-admission-control-plane';
const kiloSessionId = 'ses_00000000000000000000000000';
const sandboxId = `usr-${'a'.repeat(48)}` as const;
const INITIAL_MESSAGE_ID = 'msg_018f1e2d3c4bPrepAdmitAbCdE';

// Admitted messages leave dispatch and alarm work in the session DO. Interrupt
// each session after its test, or that work finalizes after this file closes
// and its logs race the vitest worker shutdown as pending onUserConsoleLog
// rejections.
const admittedSessions = new Set<`workspace_${string}`>();

afterEach(async () => {
  for (const sessionId of admittedSessions) {
    await runInDurableObject(
      env.SANDBOX_SESSION.getByName(`${userId}:${sessionId}`),
      async (instance, state) => {
        await instance.interruptExecution();
        await state.storage.deleteAlarm();
      }
    ).catch(() => undefined);
  }
  admittedSessions.clear();
});

function cloudId(): `workspace_${string}` {
  const sessionId = `workspace_${crypto.randomUUID()}` as const;
  admittedSessions.add(sessionId);
  return sessionId;
}

/** Mirrors `buildSessionRegistrationCommand` for the split flow: the initial
 * turn is stored in metadata and admitted only by a later initiate request. */
function preparedRegistration(sessionId: `workspace_${string}`) {
  return {
    identity: { sessionId, userId },
    auth: { kiloSessionId, kilocodeToken: 'test-session-token' },
    agent: { mode: 'code', model: 'test-model' },
    workspace: { sandboxId, sandboxProvider: 'cloudflare' as const },
    message: {
      initialMessageId: INITIAL_MESSAGE_ID,
      turn: {
        type: 'prompt' as const,
        id: INITIAL_MESSAGE_ID,
        prompt: 'prepared review prompt',
      },
    },
  };
}

describe('SandboxSession prepared initial admission (control plane)', () => {
  it('admits the stored prepared initial turn for a control-plane session', async () => {
    const sessionId = cloudId();
    const stub = env.SANDBOX_SESSION.getByName(`${userId}:${sessionId}`);

    const result = await runInDurableObject(stub, async instance => {
      await instance.registerSession(preparedRegistration(sessionId));
      const admission = await instance.admitPreparedInitialMessage({ userId });
      const messages = (await instance.ctx.storage.get('session_messages')) as
        | { messageId: string; state: string }[]
        | undefined;
      return { admission, messages };
    });

    expect(result.admission.success).toBe(true);
    if (!result.admission.success) return;
    expect(result.admission.messageId).toBe(INITIAL_MESSAGE_ID);
    expect(result.admission.outcome).toBe('queued');
    expect(result.messages).toHaveLength(1);
    expect(result.messages?.[0]?.messageId).toBe(INITIAL_MESSAGE_ID);
  });

  it('replays the admission for a retry of the same initiate request', async () => {
    const sessionId = cloudId();
    const stub = env.SANDBOX_SESSION.getByName(`${userId}:${sessionId}`);

    const result = await runInDurableObject(stub, async instance => {
      await instance.registerSession(preparedRegistration(sessionId));
      const first = await instance.admitPreparedInitialMessage({ userId });
      const retry = await instance.admitPreparedInitialMessage({ userId });
      const messages = (await instance.ctx.storage.get('session_messages')) as
        | { messageId: string }[]
        | undefined;
      return { first, retry, messages };
    });

    expect(result.first.success).toBe(true);
    expect(result.retry.success).toBe(true);
    if (!result.first.success || !result.retry.success) return;
    expect(result.retry.messageId).toBe(result.first.messageId);
    expect(result.messages).toHaveLength(1);
  });

  it('replays an already-admitted initial message from the replay probe', async () => {
    const sessionId = cloudId();
    const stub = env.SANDBOX_SESSION.getByName(`${userId}:${sessionId}`);

    const result = await runInDurableObject(stub, async instance => {
      await instance.registerSession(preparedRegistration(sessionId));
      const before = await instance.replayPreparedInitialMessage({ userId });
      await instance.admitPreparedInitialMessage({ userId });
      const after = await instance.replayPreparedInitialMessage({ userId });
      return { before, after };
    });

    expect(result.before).toBeUndefined();
    expect(result.after?.success).toBe(true);
    if (!result.after || !result.after.success) return;
    expect(result.after.messageId).toBe(INITIAL_MESSAGE_ID);
  });

  it('reports no prompt for a prepared session without a stored initial turn', async () => {
    const sessionId = cloudId();
    const stub = env.SANDBOX_SESSION.getByName(`${userId}:${sessionId}`);

    const result = await runInDurableObject(stub, async instance => {
      await instance.registerSession({
        identity: { sessionId, userId },
        auth: { kiloSessionId, kilocodeToken: 'test-session-token' },
        agent: { mode: 'code', model: 'test-model' },
        workspace: { sandboxId, sandboxProvider: 'cloudflare' as const },
      });
      return instance.admitPreparedInitialMessage({ userId });
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.code).toBe('BAD_REQUEST');
  });
});
