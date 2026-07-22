import { describe, it, expect, vi } from 'vitest';
import type { Mock } from 'vitest';
import {
  classifyAttentionKilocodeEvent,
  dispatchCloudAgentAttentionPush,
  type AttentionPushDeps,
  type CloudAgentAttentionMetadata,
} from './ingest-attention-classifier.js';
import type { AttentionEvent } from './ingest-attention-classifier.js';

const SOURCE_SESSION_ID = 'kilo_session_source';

describe('classifyAttentionKilocodeEvent', () => {
  describe('raise mappings', () => {
    it.each([
      ['question.asked', 'question'],
      ['permission.asked', 'permission'],
    ] as const)('%s with nested properties.id raises %s', (eventName, kind) => {
      const result = classifyAttentionKilocodeEvent({
        event: eventName,
        properties: { id: 'req_nested', sessionID: SOURCE_SESSION_ID },
      });
      expect(result).toEqual({
        requestId: 'req_nested',
        kind,
        sourceKiloSessionId: SOURCE_SESSION_ID,
      });
    });

    it.each([
      ['question.asked', 'question'],
      ['permission.asked', 'permission'],
    ] as const)('%s with direct top-level data.id fallback raises %s', (eventName, kind) => {
      const result = classifyAttentionKilocodeEvent({
        event: eventName,
        id: 'req_direct',
        sessionID: SOURCE_SESSION_ID,
      });
      expect(result).toEqual({
        requestId: 'req_direct',
        kind,
        sourceKiloSessionId: SOURCE_SESSION_ID,
      });
    });

    it('prefers properties.id over data.id for raise', () => {
      const result = classifyAttentionKilocodeEvent({
        event: 'question.asked',
        id: 'req_direct',
        sessionID: 'top_session',
        properties: { id: 'req_nested', sessionID: SOURCE_SESSION_ID },
      });
      expect(result).toEqual({
        requestId: 'req_nested',
        kind: 'question',
        sourceKiloSessionId: SOURCE_SESSION_ID,
      });
    });

    it('prefers properties.sessionID over data.sessionID', () => {
      const result = classifyAttentionKilocodeEvent({
        event: 'permission.asked',
        id: 'req_1',
        sessionID: 'top_session',
        properties: { id: 'req_1', sessionID: SOURCE_SESSION_ID },
      });
      expect(result).toEqual({
        requestId: 'req_1',
        kind: 'permission',
        sourceKiloSessionId: SOURCE_SESSION_ID,
      });
    });
  });

  describe('resolve events are explicitly ignored', () => {
    it.each(['question.replied', 'question.rejected', 'permission.replied'])(
      '%s returns null even with a valid id and source sessionID',
      eventName => {
        expect(
          classifyAttentionKilocodeEvent({
            event: eventName,
            properties: { id: 'req_x', requestID: 'req_x', sessionID: SOURCE_SESSION_ID },
          })
        ).toBeNull();
      }
    );
  });

  describe('ignored event types', () => {
    it.each([
      'session.status',
      'session.idle',
      'session.diff',
      'session.completed',
      'session.error',
      'session.network.asked',
      'session.network.restored',
      'message.part.delta',
      'message.part.updated',
      'message.updated',
      'message.part.removed',
      'session.created',
      'session.updated',
      'session.turn.close',
      'permission.ask', // partial
      'question.ask', // partial
      'retry.foo',
      'error.bar',
      'unknown',
    ])('ignores %s', eventName => {
      const result = classifyAttentionKilocodeEvent({
        event: eventName,
        id: 'req_1',
        properties: { id: 'req_1', sessionID: SOURCE_SESSION_ID },
      });
      expect(result).toBeNull();
    });
  });

  describe('missing or invalid id or sessionID', () => {
    it('ignores qualifying event with no id anywhere', () => {
      const result = classifyAttentionKilocodeEvent({
        event: 'question.asked',
        properties: { sessionID: SOURCE_SESSION_ID },
      });
      expect(result).toBeNull();
    });

    it('ignores qualifying event with empty string id', () => {
      const result = classifyAttentionKilocodeEvent({
        event: 'question.asked',
        id: '',
        sessionID: SOURCE_SESSION_ID,
        properties: { id: '' },
      });
      expect(result).toBeNull();
    });

    it('ignores qualifying event when source sessionID is missing', () => {
      const result = classifyAttentionKilocodeEvent({
        event: 'question.asked',
        properties: { id: 'req_present' },
      });
      expect(result).toBeNull();
    });

    it('ignores qualifying event when source sessionID is empty', () => {
      const result = classifyAttentionKilocodeEvent({
        event: 'question.asked',
        properties: { id: 'req_present', sessionID: '' },
      });
      expect(result).toBeNull();
    });

    it('ignores qualifying event with non-string id', () => {
      const result = classifyAttentionKilocodeEvent({
        event: 'question.asked',
        id: 123,
        sessionID: SOURCE_SESSION_ID,
        properties: { id: { foo: 'bar' }, sessionID: SOURCE_SESSION_ID },
      });
      expect(result).toBeNull();
    });

    it('falls back to top-level id when properties is not an object', () => {
      const result = classifyAttentionKilocodeEvent({
        event: 'question.asked',
        properties: 'not-an-object',
        id: 'req_direct',
        sessionID: SOURCE_SESSION_ID,
      });
      expect(result).toEqual({
        requestId: 'req_direct',
        kind: 'question',
        sourceKiloSessionId: SOURCE_SESSION_ID,
      });
    });

    it('returns null when properties is null and no top-level id', () => {
      const result = classifyAttentionKilocodeEvent({
        event: 'question.asked',
        properties: null,
      });
      expect(result).toBeNull();
    });
  });

  describe('non-object input', () => {
    it.each([null, undefined, 'string', 42, true, []])('returns null for %s', value => {
      expect(classifyAttentionKilocodeEvent(value)).toBeNull();
    });
  });

  describe('missing event name', () => {
    it('returns null when event is missing', () => {
      expect(classifyAttentionKilocodeEvent({ id: 'req_1' })).toBeNull();
    });

    it('returns null when event is not a string', () => {
      expect(classifyAttentionKilocodeEvent({ event: 42, id: 'req_1' })).toBeNull();
    });
  });
});

describe('dispatchCloudAgentAttentionPush', () => {
  const baseMetadata: CloudAgentAttentionMetadata = {
    auth: { kiloSessionId: 'kilo_root' },
    identity: {
      sessionId: 'sess_1',
      userId: 'user_1',
      createdOnPlatform: 'cloud-agent-web',
    },
  };

  const baseEvent: AttentionEvent = {
    requestId: 'req_1',
    kind: 'question',
    sourceKiloSessionId: 'kilo_root',
  };

  function createHarness(overrides?: { hasConnectedStreamClients?: Mock }): {
    deps: AttentionPushDeps;
    sendPush: Mock;
    hasConnectedStreamClients: Mock;
  } {
    const hasConnectedStreamClients = overrides?.hasConnectedStreamClients ?? vi.fn(() => false);
    const sendPush = vi.fn(() => Promise.resolve(undefined));
    return {
      deps: { hasConnectedStreamClients, sendPush } satisfies AttentionPushDeps,
      sendPush,
      hasConnectedStreamClients,
    };
  }

  it('dispatches with exact payload for question raise when all gates pass', async () => {
    const { deps, sendPush } = createHarness();
    const result = await dispatchCloudAgentAttentionPush(baseEvent, baseMetadata, deps);

    expect(result).toBe('sent');
    expect(sendPush).toHaveBeenCalledTimes(1);
    expect(sendPush).toHaveBeenCalledWith({
      userId: 'user_1',
      cliSessionId: 'kilo_root',
      executionId: 'attention:req_1',
      status: 'completed',
      body: 'Kilo needs your input.',
      suppressIfViewingSession: true,
    });
  });

  it('dispatches with exact payload for permission raise when all gates pass', async () => {
    const { deps, sendPush } = createHarness();
    const permissionEvent: AttentionEvent = {
      requestId: 'req_2',
      kind: 'permission',
      sourceKiloSessionId: 'kilo_root',
    };

    const result = await dispatchCloudAgentAttentionPush(permissionEvent, baseMetadata, deps);

    expect(result).toBe('sent');
    expect(sendPush).toHaveBeenCalledTimes(1);
    expect(sendPush).toHaveBeenCalledWith({
      userId: 'user_1',
      cliSessionId: 'kilo_root',
      executionId: 'attention:req_2',
      status: 'completed',
      body: 'Kilo needs your input.',
      suppressIfViewingSession: true,
    });
  });

  it('suppresses when sourceKiloSessionId does not match metadata (non-root session)', async () => {
    const { deps, sendPush } = createHarness();
    const childEvent: AttentionEvent = {
      requestId: 'req_3',
      kind: 'question',
      sourceKiloSessionId: 'kilo_child',
    };

    const result = await dispatchCloudAgentAttentionPush(childEvent, baseMetadata, deps);

    expect(result).toBe('suppressed');
    expect(sendPush).not.toHaveBeenCalled();
  });

  it('suppresses when metadata is null', async () => {
    const { deps, sendPush } = createHarness();
    const result = await dispatchCloudAgentAttentionPush(baseEvent, null, deps);

    expect(result).toBe('suppressed');
    expect(sendPush).not.toHaveBeenCalled();
  });

  it('suppresses when createdOnPlatform is not cloud-agent-web', async () => {
    const { deps, sendPush } = createHarness();
    const cliMetadata: CloudAgentAttentionMetadata = {
      auth: { kiloSessionId: 'kilo_root' },
      identity: {
        sessionId: 'sess_1',
        userId: 'user_1',
        createdOnPlatform: 'cli',
      },
    };

    const result = await dispatchCloudAgentAttentionPush(baseEvent, cliMetadata, deps);

    expect(result).toBe('suppressed');
    expect(sendPush).not.toHaveBeenCalled();
  });

  it('suppresses when metadata.auth.kiloSessionId is missing', async () => {
    const { deps, sendPush } = createHarness();
    const noKiloSessionIdMetadata: CloudAgentAttentionMetadata = {
      auth: {},
      identity: {
        sessionId: 'sess_1',
        userId: 'user_1',
        createdOnPlatform: 'cloud-agent-web',
      },
    };

    const result = await dispatchCloudAgentAttentionPush(baseEvent, noKiloSessionIdMetadata, deps);

    expect(result).toBe('suppressed');
    expect(sendPush).not.toHaveBeenCalled();
  });

  it('suppresses when hasConnectedStreamClients returns true', async () => {
    const { deps, sendPush, hasConnectedStreamClients } = createHarness({
      hasConnectedStreamClients: vi.fn(() => true),
    });

    const result = await dispatchCloudAgentAttentionPush(baseEvent, baseMetadata, deps);

    expect(result).toBe('suppressed');
    expect(sendPush).not.toHaveBeenCalled();
    expect(hasConnectedStreamClients).toHaveBeenCalledTimes(1);
  });
});
