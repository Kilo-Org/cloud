import { describe, expect, it } from 'vitest';
import type { Env } from '../types.js';
import type { StreamEvent } from '../websocket/types.js';
import {
  openNativeEventTail,
  type NativeTailPage,
  type NativeTailSeams,
  type NativeTailSink,
} from './native-event-tail.js';
import type { OpenSessionStreamSocketParams } from './session-stream-socket.js';

const KILO = 'ses_12345678901234567890123456';
const WORKSPACE = 'workspace_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function ev(eventId: number, streamEventType: string, data: unknown): StreamEvent {
  return {
    eventId: eventId as never,
    sessionId: 'session' as never,
    streamEventType: streamEventType as never,
    timestamp: '2026-01-01T00:00:00.000Z',
    data,
  };
}

function kilocode(event: string, properties: Record<string, unknown>): Record<string, unknown> {
  return { event, properties: { sessionID: KILO, ...properties } };
}

function harness() {
  let onMessage: (payload: unknown) => void = () => undefined;
  let onEnd: () => void = () => undefined;
  let closed = false;
  return {
    send: (payload: unknown) => onMessage(payload),
    end: () => onEnd(),
    closed: () => closed,
    openSocket: async (params: OpenSessionStreamSocketParams) => {
      onMessage = params.onMessage;
      onEnd = params.onEnd;
      return {
        kind: 'open' as const,
        socket: {
          close: () => {
            closed = true;
          },
        },
      };
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

function recordingSink() {
  const frames: Array<{ type: string; properties: Record<string, unknown> }> = [];
  const finishes: Array<string | undefined> = [];
  const sink: NativeTailSink = {
    send: async event => {
      frames.push(event);
    },
    finish: reason => {
      finishes.push(reason);
    },
  };
  return { frames, finishes, sink };
}

const stubEnv = {
  SANDBOX_SESSION: {
    idFromName: (name: string) => name,
    get: () => ({}),
  },
} as unknown as Env;

async function openWith(
  h: ReturnType<typeof harness>,
  readPage: () => Promise<NativeTailPage>,
  resolveRoot: NativeTailSeams['resolveRoot'] = async () => ({ cloudAgentSessionId: WORKSPACE })
) {
  return openNativeEventTail({
    env: stubEnv,
    userId: 'usr_1',
    cloudAgentSessionId: WORKSPACE,
    kiloSessionId: KILO,
    seams: { openSocket: h.openSocket, readPage, resolveRoot },
  });
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 30));
}

describe('native event tail', () => {
  it('buffers pre-fence frames and delivers low-id materialized upserts after the fence', async () => {
    const h = harness();
    const page = deferred<NativeTailPage>();
    const opened = openWith(h, () => page.promise);
    h.send(ev(2, 'kilocode', kilocode('message.updated', { messageID: 'msg_upsert' })));
    h.send(ev(5, 'kilocode', kilocode('custom.covered', { note: 'below fence' })));
    h.send(ev(11, 'kilocode', kilocode('custom.live', { note: 'above fence' })));
    page.resolve({ kind: 'page', fence: 10, events: [] });
    const result = await opened;
    if (result.kind !== 'open') throw new Error('expected an open tail');

    const sink = recordingSink();
    await result.tail.run(sink.sink);
    await settle();

    expect(sink.frames.map(frame => frame.type)).toEqual([
      'kilo.native.fence',
      'message.updated',
      'custom.live',
    ]);
    expect(sink.frames[0]?.properties).toMatchObject({ fence: 10, snapshotComplete: true });

    // A non-materialized frame at the cursor is covered; a materialized upsert is not.
    h.send(ev(11, 'kilocode', kilocode('custom.covered.again', {})));
    await settle();
    expect(sink.frames).toHaveLength(3);
    h.send(ev(11, 'kilocode', kilocode('message.part.updated', { part: { id: 'prt_1' } })));
    await settle();
    expect(sink.frames.map(frame => frame.type)).toContain('message.part.updated');
    h.send(ev(12, 'kilocode', kilocode('custom.after', {})));
    await settle();
    expect(sink.frames.at(-1)?.type).toBe('custom.after');
  });

  it('filters non-deliverable frames and delivers live deltas and cloud frames', async () => {
    const h = harness();
    const result = await openWith(h, async () => ({ kind: 'page', fence: 0, events: [] }));
    if (result.kind !== 'open') throw new Error('expected an open tail');

    const sink = recordingSink();
    await result.tail.run(sink.sink);

    h.send(ev(0, 'kilocode', kilocode('message.part.delta', { delta: 'x' })));
    h.send(ev(0, 'kilocode', kilocode('message.updated', {})));
    h.send(ev(0, 'kilocode', kilocode('message.part.delta', { delta: 'y' })));
    h.send(ev(3, 'preparing', { step: 'provision' }));
    h.send(
      ev(4, 'cloud.message.completed', {
        messageId: 'msg_completed',
        status: 'completed',
        delivery: 'sent',
        accepted: true,
      })
    );
    await settle();

    expect(sink.frames.map(frame => frame.type)).toEqual([
      'kilo.native.fence',
      'message.part.delta',
      'message.part.delta',
      'cloud.message.completed',
    ]);
  });

  it('treats a live delta during the snapshot as an unproven gap', async () => {
    const h = harness();
    const page = deferred<NativeTailPage>();
    const opened = openWith(h, () => page.promise);
    h.send(ev(0, 'kilocode', kilocode('message.part.delta', { delta: 'x' })));
    page.resolve({ kind: 'page', fence: 10, events: [] });
    const result = await opened;
    if (result.kind !== 'open') throw new Error('expected an open tail');

    const sink = recordingSink();
    await result.tail.run(sink.sink);
    await settle();

    expect(sink.frames).toEqual([]);
    expect(sink.finishes).toEqual(['continuity_unproven']);
    expect(h.closed()).toBe(true);
  });

  it('reuses a verified root mapping across bursts within the identity TTL', async () => {
    const h = harness();
    let resolves = 0;
    const result = await openWith(
      h,
      async () => ({ kind: 'page', fence: 0, events: [] }),
      async () => {
        resolves += 1;
        return { cloudAgentSessionId: WORKSPACE };
      }
    );
    if (result.kind !== 'open') throw new Error('expected an open tail');
    const sink = recordingSink();
    await result.tail.run(sink.sink);

    h.send(ev(1, 'kilocode', kilocode('custom.first', {})));
    await settle();
    h.send(ev(2, 'kilocode', kilocode('custom.second', {})));
    await settle();

    expect(sink.frames.map(frame => frame.type)).toEqual([
      'kilo.native.fence',
      'custom.first',
      'custom.second',
    ]);
    expect(resolves).toBe(1);
  });

  it('treats a socket error envelope as an unproven gap', async () => {
    const h = harness();
    const result = await openWith(h, async () => ({ kind: 'page', fence: 0, events: [] }));
    if (result.kind !== 'open') throw new Error('expected an open tail');
    const sink = recordingSink();
    await result.tail.run(sink.sink);

    h.send({ type: 'error', code: 'WS_INTERNAL_ERROR', message: 'stream failed' });
    await settle();

    expect(sink.finishes).toEqual(['continuity_unproven']);
    expect(h.closed()).toBe(true);
  });

  it('fails an oversized buffered frame instead of retaining it', async () => {
    const h = harness();
    const page = deferred<NativeTailPage>();
    const opened = openWith(h, () => page.promise);
    h.send(
      ev(
        1,
        'kilocode',
        kilocode('message.part.updated', { part: { text: 'x'.repeat(300 * 1024) } })
      )
    );
    page.resolve({ kind: 'page', fence: 0, events: [] });
    const result = await opened;
    if (result.kind !== 'open') throw new Error('expected an open tail');

    const sink = recordingSink();
    await result.tail.run(sink.sink);
    await settle();

    expect(sink.finishes).toEqual(['continuity_unproven']);
    expect(h.closed()).toBe(true);
  });

  it('counts an in-flight batch against the retained-byte bound', async () => {
    const h = harness();
    const result = await openWith(h, async () => ({ kind: 'page', fence: 0, events: [] }));
    if (result.kind !== 'open') throw new Error('expected an open tail');
    const blocked = deferred<void>();
    const frames: string[] = [];
    const finishes: Array<string | undefined> = [];
    await result.tail.run({
      send: async event => {
        frames.push(event.type);
        if (event.type !== 'kilo.native.fence') await blocked.promise;
      },
      finish: reason => {
        finishes.push(reason);
      },
    });
    const large = (id: string) =>
      kilocode('message.part.updated', { part: { id, text: 'x'.repeat(200 * 1024) } });

    h.send(ev(1, 'kilocode', large('prt_in_flight')));
    await settle();
    expect(frames).toEqual(['kilo.native.fence', 'message.part.updated']);
    h.send(ev(2, 'kilocode', large('prt_over_bound')));
    blocked.resolve();
    await settle();

    expect(finishes).toEqual(['continuity_unproven']);
    expect(h.closed()).toBe(true);
  });

  it('stops delivering and closes the socket when cancelled', async () => {
    const h = harness();
    const result = await openWith(h, async () => ({ kind: 'page', fence: 0, events: [] }));
    if (result.kind !== 'open') throw new Error('expected an open tail');
    const sink = recordingSink();
    await result.tail.run(sink.sink);

    result.tail.close();
    h.send(ev(1, 'kilocode', kilocode('custom.after-close', {})));
    await settle();

    expect(sink.frames.map(frame => frame.type)).toEqual(['kilo.native.fence']);
    expect(sink.finishes).toEqual([]);
    expect(h.closed()).toBe(true);
  });

  it('reports continuity_unproven when the socket ends after the fence', async () => {
    const h = harness();
    const result = await openWith(h, async () => ({ kind: 'page', fence: 0, events: [] }));
    if (result.kind !== 'open') throw new Error('expected an open tail');
    const sink = recordingSink();
    await result.tail.run(sink.sink);

    h.end();
    await settle();

    expect(sink.finishes).toEqual(['continuity_unproven']);
  });

  it('rejects a burst when the root mapping no longer matches', async () => {
    const h = harness();
    const result = await openWith(
      h,
      async () => ({ kind: 'page', fence: 0, events: [] }),
      async () => ({ cloudAgentSessionId: 'workspace_moved' })
    );
    if (result.kind !== 'open') throw new Error('expected an open tail');
    const sink = recordingSink();
    await result.tail.run(sink.sink);

    h.send(ev(1, 'kilocode', kilocode('custom.after-move', { text: 'after move' })));
    await settle();

    expect(sink.frames.map(frame => frame.type)).toEqual(['kilo.native.fence']);
    expect(sink.finishes).toEqual(['continuity_unproven']);
  });

  it('fails a burst after three transient identity resolve failures', async () => {
    const h = harness();
    let attempts = 0;
    const result = await openWith(
      h,
      async () => ({ kind: 'page', fence: 0, events: [] }),
      async () => {
        attempts += 1;
        throw new Error('transient');
      }
    );
    if (result.kind !== 'open') throw new Error('expected an open tail');
    const sink = recordingSink();
    await result.tail.run(sink.sink);

    h.send(ev(1, 'kilocode', kilocode('custom.live', {})));
    await settle();

    expect(attempts).toBe(3);
    expect(sink.finishes).toEqual(['continuity_unproven']);
  });

  it('abandons a burst when identity resolution exceeds its deadline', async () => {
    const h = harness();
    const result = await openWith(
      h,
      async () => ({ kind: 'page', fence: 0, events: [] }),
      () =>
        new Promise<{ cloudAgentSessionId: string } | null>(() => {
          // Never resolves: only the burst deadline can end the attempt.
        })
    );
    if (result.kind !== 'open') throw new Error('expected an open tail');
    const sink = recordingSink();
    await result.tail.run(sink.sink);

    h.send(ev(1, 'kilocode', kilocode('custom.live', {})));
    await new Promise(resolve => setTimeout(resolve, 2_300));

    expect(sink.finishes).toEqual(['continuity_unproven']);
  });

  it('reconciles authoritative status and interactions after all pages and before the fence', async () => {
    const h = harness();
    const lastPage = deferred<NativeTailPage>();
    const result = await openWith(h, async () => ({
      kind: 'page',
      fence: 10,
      events: [
        ev(1, 'kilocode', kilocode('session.status', { status: { type: 'busy' } })),
        ev(2, 'kilocode', kilocode('question.asked', { id: 'que_stale' })),
        ev(3, 'kilocode', kilocode('permission.asked', { id: 'per_stale' })),
      ],
      authority: {
        sessionStatus: { type: 'idle' },
        questions: [{ id: 'que_new', sessionID: KILO }],
        permissions: [],
      },
      nextPage: () => lastPage.promise,
    }));
    if (result.kind !== 'open') throw new Error('expected an open tail');

    const sink = recordingSink();
    const running = result.tail.run(sink.sink);
    h.send(ev(11, 'kilocode', kilocode('session.status', { status: { type: 'busy' } })));
    lastPage.resolve({
      kind: 'page',
      fence: 10,
      events: [ev(4, 'kilocode', kilocode('custom.last-page', {}))],
      authority: { questions: [{ id: 'que_new', sessionID: KILO }], permissions: [] },
    });
    await running;
    await settle();

    expect(sink.frames.map(frame => frame.type)).toEqual([
      'session.status',
      'question.asked',
      'permission.asked',
      'custom.last-page',
      'session.status',
      'question.asked',
      'question.rejected',
      'permission.replied',
      'kilo.native.fence',
      'session.status',
    ]);
    expect(sink.frames[4]?.properties).toMatchObject({ status: { type: 'idle' } });
    expect(sink.frames[5]?.properties).toMatchObject({ id: 'que_new' });
    expect(sink.frames[6]?.properties).toMatchObject({ requestID: 'que_stale' });
    expect(sink.frames[7]?.properties).toMatchObject({ requestID: 'per_stale' });
    expect(sink.frames.at(-1)?.properties).toMatchObject({ status: { type: 'busy' } });
  });

  it('delivers a duplicate live terminal row only once after the fence', async () => {
    const h = harness();
    const result = await openWith(h, async () => ({ kind: 'page', fence: 20, events: [] }));
    if (result.kind !== 'open') throw new Error('expected an open tail');
    const sink = recordingSink();
    await result.tail.run(sink.sink);

    const terminal = ev(21, 'cloud.message.completed', {
      messageId: 'msg_completed',
      status: 'completed',
      delivery: 'sent',
      accepted: true,
    });
    h.send(terminal);
    await settle();
    h.send(terminal);
    await settle();

    expect(sink.frames.map(frame => frame.type)).toEqual([
      'kilo.native.fence',
      'cloud.message.completed',
    ]);
  });

  it('reports stopped before SSE when the registration no longer matches the root', async () => {
    const h = harness();
    const result = await openWith(h, async () => ({ kind: 'stopped' }));

    expect(result.kind).toBe('stopped');
  });
});
