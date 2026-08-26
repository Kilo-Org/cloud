import { describe, expect, it } from 'vitest';
import { MAX_SANDBOX_CONTROL_FRAME_BYTES } from '../shared/sandbox-control-protocol.js';
import {
  errorResponse,
  isControlEvent,
  isControlOperation,
  okResponse,
  parseControlFrame,
  parseEventPayload,
  parseOperationPayload,
} from './frames.js';

describe('sandbox control frames', () => {
  it('accepts a valid request envelope', () => {
    const parsed = parseControlFrame(
      JSON.stringify({
        type: 'request',
        requestId: 'req_1',
        operation: 'sandbox.hello',
        payload: { protocolVersion: 1, providerInstanceId: 'inst_1' },
      })
    );
    expect(parsed.ok).toBe(true);
  });

  it('rejects invalid JSON and unknown envelopes', () => {
    expect(parseControlFrame('{').ok).toBe(false);
    expect(parseControlFrame(JSON.stringify({ type: 'nope' })).ok).toBe(false);
  });

  it('rejects oversized frames without truncating', () => {
    const parsed = parseControlFrame('x'.repeat(MAX_SANDBOX_CONTROL_FRAME_BYTES + 1));
    expect(parsed).toEqual({
      ok: false,
      error: { code: 'payload_too_large', message: 'Frame exceeds 1 MiB limit' },
    });
  });

  it('recognizes known operations', () => {
    expect(isControlOperation('sandbox.hello')).toBe(true);
    expect(isControlOperation('session.prompt')).toBe(true);
    expect(isControlOperation('http.tunnel')).toBe(false);
    expect(isControlEvent('sandbox.ready')).toBe(true);
    expect(isControlEvent('session.event')).toBe(true);
    expect(isControlEvent('session.preparing')).toBe(true);
    expect(isControlEvent('sandbox.hello')).toBe(false);
  });

  it('validates known operation and event payloads', () => {
    expect(
      parseOperationPayload('session.prompt', {
        messageId: 'msg_1',
        turn: { type: 'prompt', prompt: 'hi' },
        agent: { mode: 'code', model: 'kilo' },
      }).ok
    ).toBe(true);
    expect(
      parseOperationPayload('session.prompt', {
        messageId: 'msg_1',
        turn: { type: 'prompt', prompt: 'hi' },
        agent: { mode: 'code', model: 'kilo' },
        wrapperRunId: 'run_1',
      }).ok
    ).toBe(false);
    expect(parseOperationPayload('sandbox.status', {}).ok).toBe(true);
    expect(
      parseEventPayload('sandbox.ready', { kiloReady: true, globalFeedAttached: true }).ok
    ).toBe(true);
    expect(
      parseEventPayload('sandbox.heartbeat', {
        state: 'idle',
        kilo: { ready: true },
        sessions: [],
      }).ok
    ).toBe(true);
    expect(
      parseEventPayload('session.preparing', {
        version: 2,
        attemptId: 'att_1',
        triggerMessageId: 'msg_1',
        revision: 1,
        timestamp: 10,
        step: 'cloning',
        message: 'Cloning repository…',
        action: 'step_started',
        stepId: 'phase:cloning',
        kind: 'phase',
        label: 'cloning',
      }).ok
    ).toBe(true);
  });

  it('accepts a full sandbox.heartbeat payload', () => {
    expect(
      parseEventPayload('sandbox.heartbeat', {
        state: 'active',
        activeKiloSessions: 1,
        pendingMessages: 2,
        kilo: { ready: true },
        sessions: [
          {
            kiloSessionId: 'kilo_1',
            state: 'active',
            idleForMs: 1500,
            waitingOn: 'model',
          },
        ],
      }).ok
    ).toBe(true);
  });

  it('accepts sandbox.heartbeat with an empty sessions array', () => {
    expect(
      parseEventPayload('sandbox.heartbeat', {
        state: 'idle',
        kilo: { ready: false },
        sessions: [],
      }).ok
    ).toBe(true);
  });

  it('accepts sandbox.heartbeat waitingOn values', () => {
    for (const waitingOn of ['model', 'tool', 'finalizing'] as const) {
      expect(
        parseEventPayload('sandbox.heartbeat', {
          state: 'active',
          kilo: { ready: true },
          sessions: [
            {
              kiloSessionId: 'kilo_1',
              state: 'active',
              idleForMs: 0,
              waitingOn,
            },
          ],
        }).ok
      ).toBe(true);
    }
  });

  it('rejects sandbox.heartbeat unknown fields, missing kilo, and missing sessions', () => {
    expect(parseEventPayload('sandbox.heartbeat', { state: 'idle' }).ok).toBe(false);
    expect(
      parseEventPayload('sandbox.heartbeat', {
        state: 'idle',
        sessions: [],
      }).ok
    ).toBe(false);
    expect(
      parseEventPayload('sandbox.heartbeat', {
        state: 'idle',
        kilo: { ready: true },
      }).ok
    ).toBe(false);
    expect(
      parseEventPayload('sandbox.heartbeat', {
        state: 'idle',
        kilo: { ready: true },
        sessions: [],
        wrapperRunId: 'run_1',
      }).ok
    ).toBe(false);
    expect(
      parseEventPayload('sandbox.heartbeat', {
        state: 'idle',
        kilo: { ready: true, extra: true },
        sessions: [],
      }).ok
    ).toBe(false);
    expect(
      parseEventPayload('sandbox.heartbeat', {
        state: 'active',
        kilo: { ready: true },
        sessions: [
          {
            kiloSessionId: 'kilo_1',
            state: 'active',
            idleForMs: 0,
            wrapperRunId: 'run_1',
          },
        ],
      }).ok
    ).toBe(false);
  });

  it('builds response envelopes without logging payloads', () => {
    expect(okResponse('req_1', { handshakeComplete: true })).toEqual({
      type: 'response',
      requestId: 'req_1',
      ok: true,
      result: { handshakeComplete: true },
    });
    expect(errorResponse('req_1', 'protocol_error', 'bad', false)).toEqual({
      type: 'response',
      requestId: 'req_1',
      ok: false,
      error: { code: 'protocol_error', message: 'bad', retryable: false },
    });
  });
});
