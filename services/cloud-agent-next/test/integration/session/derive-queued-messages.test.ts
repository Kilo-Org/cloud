/**
 * Integration tests for the queued-message catch-up that runs on /stream
 * WebSocket connect. These ensure we surface pending user messages to
 * reconnecting clients without persisting a dedicated event-log row.
 *
 * The /stream path gates on a signed ticket, which makes full end-to-end
 * assertion noisy; instead we reach into the DO instance and invoke the
 * private derivation directly, which is the single function the handler
 * relies on.
 */

import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  storePendingSessionMessage,
  type PendingSessionMessage,
} from '../../../src/session/pending-messages.js';
import type { QueuedMessageSnapshot } from '../../../src/websocket/stream.js';
import { putSessionMessageState } from '../../../src/session/session-message-state.js';
import { groupedRegisterSessionInput } from '../../helpers/session-setup.js';

type DerivingInstance = {
  deriveQueuedMessages(): Promise<QueuedMessageSnapshot[]>;
};

function asDerivingInstance(instance: object): DerivingInstance {
  const maybe = instance as { deriveQueuedMessages?: unknown };
  if (typeof maybe.deriveQueuedMessages !== 'function') {
    throw new Error('deriveQueuedMessages not found on CloudAgentSession instance');
  }
  return instance as unknown as DerivingInstance;
}

// messageId pattern: msg_ + 12 lowercase hex + 14 base62 chars
const MSG_INITIAL = 'msg_018f1e2d3c4bAaBbCcDdEeFfGg';
const MSG_FOLLOWUP = 'msg_018f1e2d3c4bHhIiJjKkLlMmNn';
const MSG_SHARED = 'msg_018f1e2d3c4bOoPpQqRrSsTtUu';
const MSG_INITIATED = 'msg_018f1e2d3c4bVvWwXxYyZz0011';

const userId = 'user_queued_derive';

describe('deriveQueuedMessages (/stream connect catch-up)', () => {
  it('does not synthesize metadata fallback while lazy prep is pending', async () => {
    const sessionId = 'agent_queued_derive_1';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const snapshots = await runInDurableObject(stub, async instance => {
      const result = await instance.registerSession(
        groupedRegisterSessionInput({
          sessionId,
          userId,
          prompt: 'Build me a CLI',
          mode: 'code',
          model: 'claude',
          initialMessageId: MSG_INITIAL,
        })
      );
      expect(result.success).toBe(true);

      return asDerivingInstance(instance).deriveQueuedMessages();
    });

    expect(snapshots).toEqual([]);
  });

  it('returns every entry in the pending_message:* queue', async () => {
    const sessionId = 'agent_queued_derive_2';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const message: PendingSessionMessage = {
      messageId: MSG_FOLLOWUP,
      role: 'user',
      content: 'follow-up question',
      executionId: 'exc_01abcdefabcdefabcdefabcdef',
      createdAt: 1700000000000,
    };

    const snapshots = await runInDurableObject(stub, async instance => {
      await storePendingSessionMessage(instance.ctx.storage, message);
      return asDerivingInstance(instance).deriveQueuedMessages();
    });

    expect(snapshots).toEqual([
      {
        messageId: message.messageId,
        content: 'follow-up question',
        timestamp: 1700000000000,
      },
    ]);
  });

  it('deduplicates the metadata entry when pending_message already has it', async () => {
    const sessionId = 'agent_queued_derive_3';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const snapshots = await runInDurableObject(stub, async instance => {
      await instance.registerSession(
        groupedRegisterSessionInput({
          sessionId,
          userId,
          prompt: 'initial prompt',
          mode: 'code',
          model: 'claude',
          initialMessageId: MSG_SHARED,
        })
      );
      await storePendingSessionMessage(instance.ctx.storage, {
        messageId: MSG_SHARED,
        role: 'user',
        content: 'initial prompt',
        executionId: 'exc_01sharedabcdefabcdefabcdef',
        createdAt: 1700000001000,
      });
      return asDerivingInstance(instance).deriveQueuedMessages();
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].messageId).toBe(MSG_SHARED);
  });

  it('suppresses the metadata entry once initiation has begun', async () => {
    const sessionId = 'agent_queued_derive_4';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const snapshots = await runInDurableObject(stub, async instance => {
      await instance.registerSession(
        groupedRegisterSessionInput({
          sessionId,
          userId,
          prompt: 'already initiated prompt',
          mode: 'code',
          model: 'claude',
          initialMessageId: MSG_INITIATED,
        })
      );

      // Simulate a session that has finished prep + started initiation.
      // The authoritative user bubble is already being carried by the
      // wrapper snapshot, so the catch-up must stay silent.
      const existing = await instance.ctx.storage.get<Record<string, unknown>>('metadata');
      expect(existing).toBeDefined();
      await instance.ctx.storage.put('metadata', {
        ...existing,
        lifecycle: {
          ...((existing?.lifecycle as Record<string, unknown> | undefined) ?? {}),
          preparedAt: Date.now(),
          initiatedAt: Date.now(),
          version: Date.now(),
          timestamp: Date.now(),
        },
      });

      return asDerivingInstance(instance).deriveQueuedMessages();
    });

    expect(snapshots).toEqual([]);
  });

  it('returns nothing for a brand-new DO with no metadata or queue', async () => {
    const sessionId = 'agent_queued_derive_5';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const snapshots = await runInDurableObject(stub, async instance =>
      asDerivingInstance(instance).deriveQueuedMessages()
    );

    expect(snapshots).toEqual([]);
  });

  it('rehydrates never-accepted exhausted prompts with queued then failed catch-up data', async () => {
    const sessionId = 'agent_queued_derive_exhausted';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const snapshots = await runInDurableObject(stub, async instance => {
      await putSessionMessageState(instance.ctx.storage, {
        messageId: MSG_FOLLOWUP,
        status: 'failed',
        prompt: 'prompt that never reached the wrapper',
        createdAt: 1700000003000,
        queuedAt: 1700000003000,
        terminalAt: 1700000004000,
        completionSource: 'delivery_failure',
        failureReason: 'exhausted',
        error: 'Pending message delivery failed',
        attempts: 4,
      });

      return asDerivingInstance(instance).deriveQueuedMessages();
    });

    expect(snapshots).toEqual([
      {
        messageId: MSG_FOLLOWUP,
        content: 'prompt that never reached the wrapper',
        timestamp: 1700000003000,
        terminalFailure: {
          status: 'failed',
          completionSource: 'delivery_failure',
          reason: 'exhausted',
          error: 'Pending message delivery failed',
          attempts: 4,
          timestamp: 1700000004000,
        },
      },
    ]);
  });

  it('returns new-path pending message without executionId', async () => {
    const sessionId = 'agent_queued_derive_6';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`)
    );

    const message: PendingSessionMessage = {
      messageId: MSG_FOLLOWUP,
      role: 'user',
      content: 'new-path follow-up',
      // executionId intentionally omitted — new-path messages don't have one
      createdAt: 1700000002000,
    };

    const snapshots = await runInDurableObject(stub, async instance => {
      await storePendingSessionMessage(instance.ctx.storage, message);
      return asDerivingInstance(instance).deriveQueuedMessages();
    });

    expect(snapshots).toEqual([
      {
        messageId: message.messageId,
        content: 'new-path follow-up',
        timestamp: 1700000002000,
      },
    ]);
    expect(snapshots[0]).not.toHaveProperty('executionId');
  });
});
