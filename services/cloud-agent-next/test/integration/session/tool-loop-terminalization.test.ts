import { env, listDurableObjectIds, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import type { CloudAgentSession } from '../../../src/persistence/CloudAgentSession.js';
import { createEventQueries } from '../../../src/session/queries/events.js';
import {
  allocateWrapperRuntimeState,
  recordWrapperDispatchingMessage,
  type ActiveWrapperRuntimeState,
} from '../../../src/session/wrapper-runtime-state.js';
import { storePendingSessionMessage } from '../../../src/session/pending-messages.js';
import { putSessionMessageState } from '../../../src/session/session-message-state.js';
import type { IngestAttachment, IngestHandler } from '../../../src/websocket/ingest.js';
import type { IngestEvent } from '../../../src/websocket/types.js';
import {
  productionFixtureDenylist,
  reconstructedToolLoopTurnFixtures,
  type ToolLoopTurnFixture,
} from '../../fixtures/tool-loop-turn-events.js';
import { registerReadySession } from '../../helpers/session-setup.js';

async function resetSessions(): Promise<void> {
  const ids = await listDurableObjectIds(env.CLOUD_AGENT_SESSION);
  await Promise.all(
    ids.map(id =>
      runInDurableObject(env.CLOUD_AGENT_SESSION.get(id), instance =>
        instance.ctx.storage.deleteAll()
      )
    )
  );
}

function createIngestSocket(sessionId: string, wrapperState: ActiveWrapperRuntimeState): WebSocket {
  const attachment: IngestAttachment = {
    wrapperRunId: wrapperState.wrapperRunId,
    sessionId,
    connectedAt: Date.now(),
    kiloSessionState: { captured: false },
    lastHeartbeatUpdate: Date.now(),
    lastEventAtUpdate: Date.now(),
    wrapperGeneration: wrapperState.wrapperGeneration,
    wrapperConnectionId: wrapperState.wrapperConnectionId,
  };
  return {
    deserializeAttachment: () => attachment,
    serializeAttachment: () => {},
    send: () => {},
    close: () => {},
  } as unknown as WebSocket;
}

async function getIngestHandler(instance: CloudAgentSession): Promise<IngestHandler> {
  const privateAccess = instance as unknown as {
    getIngestHandler(): Promise<IngestHandler>;
  };
  return privateAccess.getIngestHandler();
}

async function replayEvents(
  handler: IngestHandler,
  ws: WebSocket,
  events: IngestEvent[]
): Promise<void> {
  for (const event of events) {
    await handler.handleIngestMessage(ws, JSON.stringify(event));
  }
}

async function seedAcceptedTurn(
  instance: CloudAgentSession,
  fixture: ToolLoopTurnFixture,
  sessionId: string
) {
  await registerReadySession(instance, {
    sessionId,
    userId: `user_${fixture.label}`,
    orgId: `org_${fixture.label}`,
    kiloSessionId: fixture.rootKiloSessionId,
    prompt: 'Inspect the synthetic workspace without modifying files.',
    mode: 'code',
    model: 'test-model',
    kilocodeToken: `token_${fixture.label}`,
  });
  const { state: wrapperState } = await allocateWrapperRuntimeState(instance.ctx.storage);
  await putSessionMessageState(instance.ctx.storage, {
    messageId: fixture.userMessageId,
    status: 'accepted',
    prompt: 'Inspect the synthetic workspace without modifying files.',
    createdAt: Date.now(),
    acceptedAt: Date.now(),
    wrapperRunId: wrapperState.wrapperRunId,
  });
  return wrapperState;
}

function completedEvents(state: DurableObjectState) {
  return createEventQueries(
    drizzle(state.storage, { logger: false }),
    state.storage.sql
  ).findByFilters({
    eventTypes: ['cloud.message.completed'],
  });
}

describe('tool-loop terminalization replay', () => {
  beforeEach(resetSessions);

  it('contains only reconstructed sanitized fixture values', () => {
    const serializedFixtures = JSON.stringify(reconstructedToolLoopTurnFixtures);
    for (const forbiddenPattern of productionFixtureDenylist) {
      expect(serializedFixtures).not.toMatch(forbiddenPattern);
    }
  });

  for (const fixture of reconstructedToolLoopTurnFixtures) {
    it(`settles ${fixture.label} to the final assistant only after wrapper completion`, async () => {
      const sessionId = `agent_synthetic_${fixture.label}`;
      const stub = env.CLOUD_AGENT_SESSION.get(
        env.CLOUD_AGENT_SESSION.idFromName(`user_${fixture.label}:${sessionId}`)
      );

      const result = await runInDurableObject(stub, async (instance, state) => {
        const wrapperState = await seedAcceptedTurn(instance, fixture, sessionId);
        const handler = await getIngestHandler(instance);
        const ws = createIngestSocket(sessionId, wrapperState);

        await replayEvents(handler, ws, fixture.eventsBeforeIdle.slice(0, 1));
        const afterIntermediate = await instance.getMessageResult(fixture.userMessageId);
        const completedAfterIntermediate = completedEvents(state).length;

        await replayEvents(handler, ws, fixture.eventsBeforeIdle.slice(1));
        await replayEvents(handler, ws, [fixture.childIdle]);
        const afterChildIdle = await instance.getMessageResult(fixture.userMessageId);
        await replayEvents(handler, ws, [fixture.rootIdle]);
        const afterRootIdle = await instance.getMessageResult(fixture.userMessageId);
        const completedAfterRootIdle = completedEvents(state).length;

        await replayEvents(handler, ws, [fixture.wrapperComplete]);
        const afterWrapperComplete = await instance.getMessageResult(fixture.userMessageId);
        const completedAfterWrapperComplete = completedEvents(state).length;

        return {
          afterIntermediate,
          completedAfterIntermediate,
          afterChildIdle,
          afterRootIdle,
          completedAfterRootIdle,
          afterWrapperComplete,
          completedAfterWrapperComplete,
        };
      });

      expect(result.afterIntermediate).toMatchObject({
        type: 'found',
        result: { status: 'running' },
      });
      expect(result.completedAfterIntermediate).toBe(0);
      expect(result.afterChildIdle).toMatchObject({
        type: 'found',
        result: { status: 'running' },
      });
      expect(result.afterRootIdle).toMatchObject({
        type: 'found',
        result: { status: 'running' },
      });
      expect(result.completedAfterRootIdle).toBe(0);
      expect(result.afterWrapperComplete).toMatchObject({
        type: 'found',
        result: {
          status: 'completed',
          completionSource: 'idle_reconciliation',
          assistant: {
            messageId: fixture.finalAssistantMessageId,
            text: fixture.finalText,
          },
        },
      });
      expect(result.completedAfterWrapperComplete).toBe(1);
    });
  }

  it('settles the final assistant from bare wrapper completion when root idle is lost', async () => {
    const fixture = reconstructedToolLoopTurnFixtures[0];
    if (!fixture) throw new Error('Expected a reconstructed tool-loop fixture');
    const sessionId = 'agent_synthetic_bare_complete';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`user_synthetic_bare_complete:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async (instance, state) => {
      const wrapperState = await seedAcceptedTurn(instance, fixture, sessionId);
      const handler = await getIngestHandler(instance);
      const ws = createIngestSocket(sessionId, wrapperState);

      await replayEvents(handler, ws, fixture.eventsBeforeIdle);
      await replayEvents(handler, ws, [fixture.wrapperComplete]);

      return {
        messageResult: await instance.getMessageResult(fixture.userMessageId),
        completedEventCount: completedEvents(state).length,
      };
    });

    expect(result.messageResult).toMatchObject({
      type: 'found',
      result: {
        status: 'completed',
        completionSource: 'idle_reconciliation',
        assistant: {
          messageId: fixture.finalAssistantMessageId,
          text: fixture.finalText,
        },
      },
    });
    expect(result.completedEventCount).toBe(1);
  });

  it('repairs a legacy complete that wins the acceptance persistence race', async () => {
    const fixture = reconstructedToolLoopTurnFixtures[0];
    if (!fixture) throw new Error('Expected a reconstructed tool-loop fixture');
    const sessionId = 'agent_synthetic_legacy_complete_race';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`user_synthetic_legacy_complete_race:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async instance => {
      await registerReadySession(instance, {
        sessionId,
        userId: 'user_synthetic_legacy_complete_race',
        kiloSessionId: fixture.rootKiloSessionId,
        prompt: 'Inspect the synthetic workspace without modifying files.',
        mode: 'code',
        model: 'test-model',
        kilocodeToken: 'token_synthetic_legacy_complete_race',
      });
      const { state: wrapperState } = await allocateWrapperRuntimeState(instance.ctx.storage);
      await instance.ctx.storage.put('wrapper_runtime_state', {
        wrapperGeneration: wrapperState.wrapperGeneration,
        wrapperConnectionId: wrapperState.wrapperConnectionId,
        wrapperRunId: wrapperState.wrapperRunId,
        lastWrapperConnectedAt: wrapperState.lastWrapperConnectedAt,
      });
      await recordWrapperDispatchingMessage(
        instance.ctx.storage,
        wrapperState,
        fixture.userMessageId
      );
      await storePendingSessionMessage(instance.ctx.storage, {
        messageId: fixture.userMessageId,
        content: 'Inspect the synthetic workspace without modifying files.',
        createdAt: Date.now(),
        intent: {
          turn: {
            type: 'prompt',
            messageId: fixture.userMessageId,
            prompt: 'Inspect the synthetic workspace without modifying files.',
          },
          agent: { mode: 'code', model: 'test-model' },
        },
      });
      const handler = await getIngestHandler(instance);
      const ws = createIngestSocket(sessionId, wrapperState);

      await replayEvents(handler, ws, fixture.eventsBeforeIdle);
      await replayEvents(handler, ws, [
        {
          streamEventType: 'complete',
          data: { exitCode: 0 },
          timestamp: new Date().toISOString(),
        },
      ]);

      return instance.getMessageResult(fixture.userMessageId);
    });

    expect(result).toMatchObject({
      type: 'found',
      result: {
        status: 'completed',
        completionSource: 'idle_reconciliation',
        assistant: { messageId: fixture.finalAssistantMessageId },
      },
    });
  });

  it('does not settle accepted work from raw idle maintenance', async () => {
    const fixture = reconstructedToolLoopTurnFixtures[1];
    if (!fixture) throw new Error('Expected a reconstructed tool-loop fixture');
    const sessionId = 'agent_synthetic_no_idle_fallback';
    const stub = env.CLOUD_AGENT_SESSION.get(
      env.CLOUD_AGENT_SESSION.idFromName(`user_synthetic_no_idle_fallback:${sessionId}`)
    );

    const result = await runInDurableObject(stub, async (instance, state) => {
      const wrapperState = await seedAcceptedTurn(instance, fixture, sessionId);
      const handler = await getIngestHandler(instance);
      const ws = createIngestSocket(sessionId, wrapperState);

      await replayEvents(handler, ws, fixture.eventsBeforeIdle);
      await replayEvents(handler, ws, [fixture.rootIdle]);
      await instance.alarm();

      return {
        messageResult: await instance.getMessageResult(fixture.userMessageId),
        completedEventCount: completedEvents(state).length,
      };
    });

    expect(result.messageResult).toMatchObject({ type: 'found', result: { status: 'running' } });
    expect(result.completedEventCount).toBe(0);
  });
});
