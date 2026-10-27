import { describe, expect, it } from 'vitest';
import type { Env } from '../types.js';
import type { SandboxStatusSnapshot } from '../shared/sandbox-status.js';
import {
  openSystemFeedStream,
  defaultSystemFeedUpstream,
  projectSystemFeedEvent,
  type SystemFeedChannel,
  type SystemFeedUpstreamFactory,
  type SystemFeedUpstreamFrame,
} from './system-feed.js';

const kiloSessionId = 'ses_0123456789abcdefghijklmnop';
const cloudAgentSessionId = `workspace_${'0'.repeat(8)}-0000-0000-0000-000000000000`;
const env = {} as Env;

function startingSnapshot(): SandboxStatusSnapshot {
  return {
    status: 'starting',
    provider: 'Cloudflare',
    observedAt: 1_700_000_000_000,
    detailCode: 'sandbox_starting',
    inactivityTimeoutMs: null,
    estimatedSleepAt: null,
  };
}

describe('projectSystemFeedEvent', () => {
  it('projects a preparation step with the public ids and projected payload', () => {
    expect(
      projectSystemFeedEvent(
        'preparing',
        { version: 2, action: 'step_started', step: 'cloning', message: 'Cloning repository' },
        kiloSessionId
      )
    ).toEqual({
      type: 'preparing',
      properties: {
        sessionID: kiloSessionId,
        directory: `/cloud-agent/sessions/${kiloSessionId}`,
        preparation: {
          version: 2,
          action: 'step_started',
          step: 'cloning',
          message: 'Cloning repository',
        },
      },
    });
  });

  it('drops a preparation payload that carries no step', () => {
    expect(projectSystemFeedEvent('preparing', { message: 'no step' }, kiloSessionId)).toBeNull();
    expect(projectSystemFeedEvent('preparing', 'not-an-object', kiloSessionId)).toBeNull();
  });

  it('projects the cloud lifecycle from a cloud.status event and from the connect snapshot', () => {
    const expected = {
      type: 'cloud.status',
      properties: {
        sessionID: kiloSessionId,
        directory: `/cloud-agent/sessions/${kiloSessionId}`,
        cloudStatus: { type: 'preparing', step: 'cloning' },
      },
    };
    expect(
      projectSystemFeedEvent(
        'cloud.status',
        { cloudStatus: { type: 'preparing', step: 'cloning' } },
        kiloSessionId
      )
    ).toEqual(expected);
    expect(
      projectSystemFeedEvent(
        'connected',
        { cloudStatus: { type: 'preparing', step: 'cloning' } },
        kiloSessionId
      )
    ).toEqual(expected);
    expect(projectSystemFeedEvent('connected', {}, kiloSessionId)).toBeNull();
  });

  it('validates the sandbox status snapshot and rejects an invalid one', () => {
    const snapshot = startingSnapshot();
    expect(projectSystemFeedEvent('cloud.sandbox.status', snapshot, kiloSessionId)).toEqual({
      type: 'cloud.sandbox.status',
      properties: {
        sessionID: kiloSessionId,
        directory: `/cloud-agent/sessions/${kiloSessionId}`,
        sandbox: snapshot,
      },
    });
    expect(
      projectSystemFeedEvent('cloud.sandbox.status', { status: 'starting' }, kiloSessionId)
    ).toBeNull();
  });

  it('drops any event type outside the allowlist', () => {
    expect(projectSystemFeedEvent('kilocode', { type: 'message' }, kiloSessionId)).toBeNull();
    expect(projectSystemFeedEvent('output', 'hello', kiloSessionId)).toBeNull();
    expect(
      projectSystemFeedEvent('cloud.message.sent', { messageId: 'msg' }, kiloSessionId)
    ).toBeNull();
  });
});

type UpstreamDouble = {
  factory: SystemFeedUpstreamFactory;
  ready: Promise<void>;
  push: (frame: SystemFeedUpstreamFrame) => void;
  end: (channel: SystemFeedChannel) => void;
  closeCount: () => number;
};

function upstreamDouble(): UpstreamDouble {
  let onFrame: (frame: SystemFeedUpstreamFrame) => void = () => undefined;
  let onEnd: (channel: SystemFeedChannel) => void = () => undefined;
  let closed = 0;
  let markReady: () => void = () => undefined;
  const ready = new Promise<void>(resolve => {
    markReady = resolve;
  });
  return {
    factory: async params => {
      onFrame = params.onFrame;
      onEnd = params.onEnd;
      markReady();
      return {
        close() {
          closed += 1;
        },
      };
    },
    ready,
    push: frame => onFrame(frame),
    end: channel => onEnd(channel),
    closeCount: () => closed,
  };
}

async function readSseEvents(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  count: number
): Promise<unknown[]> {
  const decoder = new TextDecoder();
  const events: unknown[] = [];
  let buffer = '';
  while (events.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let separator = buffer.indexOf('\n\n');
    while (separator !== -1) {
      const chunk = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      const dataLine = chunk.split('\n').find(line => line.startsWith('data: '));
      if (dataLine !== undefined) events.push(JSON.parse(dataLine.slice('data: '.length)));
      separator = buffer.indexOf('\n\n');
    }
  }
  return events;
}

function openStream(upstream: UpstreamDouble): ReadableStreamDefaultReader<Uint8Array> {
  const response = openSystemFeedStream({
    env,
    userId: 'usr_1',
    cloudAgentSessionId,
    kiloSessionId,
    openUpstream: upstream.factory,
  });
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  if (response.body === null) throw new Error('expected an SSE body');
  return response.body.getReader();
}

describe('openSystemFeedStream', () => {
  it('fails instead of sending heartbeats forever when upstream startup fails', async () => {
    const response = openSystemFeedStream({
      env,
      userId: 'usr_1',
      cloudAgentSessionId,
      kiloSessionId,
      openUpstream: async () => {
        throw new Error('unavailable');
      },
    });
    await expect(response.text()).rejects.toThrow('System event source unavailable');
  });

  it('releases upstreams that finish opening after the subscriber cancels', async () => {
    const opening = Promise.withResolvers<{ close(): void }>();
    let closed = 0;
    const response = openSystemFeedStream({
      env,
      userId: 'usr_1',
      cloudAgentSessionId,
      kiloSessionId,
      openUpstream: () => opening.promise,
    });
    if (!response.body) throw new Error('expected SSE body');
    const cancelled = response.body.cancel();
    opening.resolve({
      close: () => {
        closed += 1;
      },
    });
    await cancelled;
    await Promise.resolve();
    expect(closed).toBe(1);
  });

  it('rejects a failed Session DO WebSocket upgrade', async () => {
    const failedEnv = {
      SANDBOX_SESSION: {
        idFromName: () => 'test',
        get: () => ({ fetch: async () => new Response(null, { status: 503 }) }),
      },
    } as unknown as Env;
    await expect(
      defaultSystemFeedUpstream({
        env: failedEnv,
        userId: 'usr_1',
        cloudAgentSessionId,
        onFrame: () => undefined,
        onEnd: () => undefined,
      })
    ).rejects.toThrow('System event source unavailable');
  });

  it('replays and then tails preparation and cloud events from the event channel', async () => {
    const upstream = upstreamDouble();
    const reader = openStream(upstream);
    await upstream.ready;
    upstream.push({
      channel: 'events',
      payload: { streamEventType: 'preparing', data: { step: 'cloning', message: 'replayed' } },
    });
    upstream.push({
      channel: 'events',
      payload: { streamEventType: 'cloud.status', data: { cloudStatus: { type: 'ready' } } },
    });

    const events = await readSseEvents(reader, 2);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'preparing',
        properties: expect.objectContaining({ sessionID: kiloSessionId }),
      }),
      expect.objectContaining({
        type: 'cloud.status',
        properties: expect.objectContaining({ cloudStatus: { type: 'ready' } }),
      }),
    ]);

    // A live push after the replay is delivered too.
    upstream.push({
      channel: 'events',
      payload: { streamEventType: 'preparing', data: { step: 'ready', message: 'live' } },
    });
    const live = await readSseEvents(reader, 1);
    expect(live).toEqual([
      expect.objectContaining({
        type: 'preparing',
        properties: expect.objectContaining({ preparation: { step: 'ready', message: 'live' } }),
      }),
    ]);
    await reader.cancel();
  });

  it('streams the sandbox status snapshot and live updates from the sandbox channel', async () => {
    const upstream = upstreamDouble();
    const reader = openStream(upstream);
    await upstream.ready;
    upstream.push({
      channel: 'sandbox',
      payload: { streamEventType: 'cloud.sandbox.status', data: startingSnapshot() },
    });
    const sleeping = { ...startingSnapshot(), status: 'sleeping', detailCode: 'sandbox_stopped' };
    upstream.push({
      channel: 'sandbox',
      payload: { streamEventType: 'cloud.sandbox.status', data: sleeping },
    });

    const events = await readSseEvents(reader, 2);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'cloud.sandbox.status',
        properties: expect.objectContaining({ sandbox: startingSnapshot() }),
      }),
      expect.objectContaining({
        type: 'cloud.sandbox.status',
        properties: expect.objectContaining({ sandbox: sleeping }),
      }),
    ]);
    await reader.cancel();
  });

  it('drops non-allowlisted upstream frames and keeps only the allowlisted ones', async () => {
    const upstream = upstreamDouble();
    const reader = openStream(upstream);
    await upstream.ready;
    upstream.push({
      channel: 'events',
      payload: { streamEventType: 'kilocode', data: { secret: 'x' } },
    });
    upstream.push({
      channel: 'events',
      payload: { streamEventType: 'preparing', data: { step: 'branch' } },
    });

    const events = await readSseEvents(reader, 1);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'preparing',
        properties: expect.objectContaining({ preparation: { step: 'branch' } }),
      }),
    ]);
    await reader.cancel();
  });

  it('closes both upstreams when the subscriber cancels', async () => {
    const upstream = upstreamDouble();
    const reader = openStream(upstream);
    await upstream.ready;
    await reader.cancel();
    expect(upstream.closeCount()).toBe(1);
  });

  it('closes the upstreams and errors the subscriber on backpressure', async () => {
    const upstream = upstreamDouble();
    const reader = openStream(upstream);
    await upstream.ready;
    for (let index = 0; index < 200; index += 1) {
      upstream.push({
        channel: 'events',
        payload: { streamEventType: 'preparing', data: { step: 'cloning' } },
      });
    }
    await expect(reader.read()).rejects.toThrow('fell behind');
    expect(upstream.closeCount()).toBe(1);
  });

  it('closes the stream when the event channel ends so the client replays', async () => {
    const upstream = upstreamDouble();
    const reader = openStream(upstream);
    await upstream.ready;
    upstream.end('events');
    const { done } = await reader.read();
    expect(done).toBe(true);
  });

  it('closes the stream when the sandbox status channel ends so status cannot silently go stale', async () => {
    const upstream = upstreamDouble();
    const reader = openStream(upstream);
    await upstream.ready;
    upstream.end('sandbox');
    expect((await reader.read()).done).toBe(true);
    expect(upstream.closeCount()).toBe(1);
  });
});
