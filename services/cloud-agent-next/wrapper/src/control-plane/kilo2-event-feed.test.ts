import { expect, it } from 'bun:test';
import { createKilo2EventFeed, nativeTurnError } from './kilo2-event-feed.js';
import { classifyAssistantFailure } from '../../../src/shared/assistant-failure.js';
import type { KiloFeedEvent } from './kilo-event-feed.js';
import type { HarnessActivityEvent } from './harness-activity.js';

it('does not acknowledge a later prompt from an earlier interrupted execution snapshot', async () => {
  const directory = '/workspace';
  const sessionID = 'ses_local';
  const events: KiloFeedEvent[] = [];
  const activity: HarnessActivityEvent[] = [];
  const messages = () =>
    activity.flatMap(event => (event.activity.type === 'message' ? [event.activity.message] : []));
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const frame = (type: string, data: Record<string, unknown>, created = 10) =>
    new TextEncoder().encode(
      `data: ${JSON.stringify({ id: `evt_${type}`, type, data, created, location: { directory } })}\n\n`
    );
  const native = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname === '/api/event')
        return new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              controller = stream;
              stream.enqueue(frame('server.connected', {}));
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } }
        );
      if (pathname.endsWith('/message'))
        return Response.json({
          data: [
            { id: 'msg_next', type: 'user', text: 'next prompt', time: { created: 20 } },
            { id: 'msg_old', type: 'user', text: 'old prompt', time: { created: 1 } },
          ],
          cursor: { next: null },
        });
      return Response.json({
        data: { id: sessionID, location: { directory }, time: { created: 0, updated: 20 } },
      });
    },
  });
  const feed = createKilo2EventFeed({
    source: { server: { url: native.url.origin }, directory, nativeRuntimeId: 'runtime_local' },
    signal: AbortSignal.timeout(5000),
    onEvent: event => events.push(event),
    onHarnessActivity: event => activity.push(event),
    onFailure() {
      throw new Error('Native feed failed');
    },
  });
  async function until(predicate: () => boolean) {
    const deadline = Date.now() + 2000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('Native event did not arrive');
      await Bun.sleep(5);
    }
  }
  try {
    await feed.open();
    controller?.enqueue(frame('session.execution.interrupted', { sessionID }));
    await until(() => events.some(event => event.type === 'session.turn.close'));
    expect(messages()).toEqual([]);
    const idle = events.findIndex(event => event.type === 'session.status');
    const close = events.findIndex(event => event.type === 'session.turn.close');
    expect(idle).toBeLessThan(close);
    controller?.enqueue(frame('session.execution.started', { sessionID }, 21));
    controller?.enqueue(frame('session.inbox.delivered', { sessionID, inboxID: 'msg_next' }, 22));
    await until(() => messages().length > 0);
    expect(messages()).toEqual([
      { sessionId: sessionID, id: 'msg_next', role: 'user', time: { created: 20 } },
    ]);
    expect(events.some(event => event.type.startsWith('message.'))).toBe(false);
  } finally {
    feed.close();
    await native.stop(true);
  }
});

it('closes the turn and keeps the feed open when a native read fails', async () => {
  const directory = '/workspace';
  const sessionID = 'ses_local';
  const events: KiloFeedEvent[] = [];
  const logs: string[] = [];
  let failures = 0;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const frame = (type: string, data: Record<string, unknown>) =>
    new TextEncoder().encode(
      `data: ${JSON.stringify({ id: `evt_${type}`, type, data, created: 10, location: { directory } })}\n\n`
    );
  const native = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname === '/api/event')
        return new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              controller = stream;
              stream.enqueue(frame('server.connected', {}));
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } }
        );
      if (pathname.endsWith('/message')) return new Response('unavailable', { status: 500 });
      return Response.json({
        data: { id: sessionID, location: { directory }, time: { created: 0, updated: 20 } },
      });
    },
  });
  const feed = createKilo2EventFeed({
    source: { server: { url: native.url.origin }, directory, nativeRuntimeId: 'runtime_local' },
    signal: AbortSignal.timeout(5000),
    onEvent: event => events.push(event),
    onFailure: () => (failures += 1),
    log: message => logs.push(message),
  });
  async function until(predicate: () => boolean) {
    const deadline = Date.now() + 2000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('Native event did not arrive');
      await Bun.sleep(5);
    }
  }
  try {
    await feed.open();
    controller?.enqueue(frame('session.execution.succeeded', { sessionID }));
    controller?.enqueue(frame('session.renamed', { sessionID }));
    await until(() => events.some(event => event.type === 'session.updated'));
    expect(events.map(event => event.type)).toContain('session.turn.close');
    expect(logs.some(message => message.includes('phase=frame_failed'))).toBe(true);
    expect(failures).toBe(0);
  } finally {
    feed.close();
    await native.stop(true);
  }
});

it('forwards an unchanged assistant projection once', async () => {
  const directory = '/workspace';
  const sessionID = 'ses_local';
  const events: KiloFeedEvent[] = [];
  let text = 'first';
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const frame = (type: string, data: Record<string, unknown>) =>
    new TextEncoder().encode(
      `data: ${JSON.stringify({ id: `evt_${type}`, type, data, created: 10, location: { directory } })}\n\n`
    );
  const native = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname === '/api/event')
        return new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              controller = stream;
              stream.enqueue(frame('server.connected', {}));
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } }
        );
      if (pathname.endsWith('/message'))
        return Response.json({
          data: [
            {
              id: 'msg_answer',
              type: 'assistant',
              time: { created: 2 },
              content: [{ type: 'text', text }],
            },
          ],
          cursor: { next: null },
        });
      return Response.json({
        data: { id: sessionID, location: { directory }, time: { created: 0, updated: 20 } },
      });
    },
  });
  const feed = createKilo2EventFeed({
    source: { server: { url: native.url.origin }, directory, nativeRuntimeId: 'runtime_local' },
    signal: AbortSignal.timeout(5000),
    onEvent: event => events.push(event),
    onHarnessActivity: event => activity.push(event),
    onFailure() {},
  });
  const activity: HarnessActivityEvent[] = [];
  const updates = () => events.filter(event => event.type === 'conversation.message.updated');
  async function until(predicate: () => boolean) {
    const deadline = Date.now() + 2000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('Native event did not arrive');
      await Bun.sleep(5);
    }
  }
  try {
    await feed.open();
    controller?.enqueue(frame('session.tool.started', { sessionID }));
    controller?.enqueue(frame('session.tool.ended', { sessionID }));
    controller?.enqueue(frame('session.renamed', { sessionID }));
    await until(() => events.some(event => event.type === 'session.updated'));
    expect(updates()).toHaveLength(1);
    text = 'second';
    controller?.enqueue(frame('session.step.ended', { sessionID }));
    await until(() => updates().length === 2);
    expect(updates()[1].properties).toMatchObject({ parentID: '', message: { id: 'msg_answer' } });
    // Each changed read reports the message, then its parts under the delta identity.
    expect(
      activity.map(event =>
        event.activity.type === 'part'
          ? `part:${event.activity.part.id}:${event.activity.part.text}`
          : event.activity.type
      )
    ).toEqual([
      'message',
      'part:msg_answer_text_0:first',
      'message',
      'part:msg_answer_text_0:second',
    ]);
  } finally {
    feed.close();
    await native.stop(true);
  }
});

it('contains a throwing failure callback when the native stream ends', async () => {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let failures = 0;
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  const native = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            controller = stream;
            stream.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ id: 'evt_connected', type: 'server.connected', data: {}, created: 1 })}\n\n`
              )
            );
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } }
      );
    },
  });
  const feed = createKilo2EventFeed({
    source: {
      server: { url: native.url.origin },
      directory: '/workspace',
      nativeRuntimeId: 'runtime_local',
    },
    signal: AbortSignal.timeout(5000),
    onEvent() {},
    onFailure() {
      failures += 1;
      throw new Error('Native feed failed');
    },
  });
  try {
    await feed.open();
    controller?.close();
    const deadline = Date.now() + 2000;
    while (failures === 0) {
      if (Date.now() > deadline) throw new Error('Feed failure was not reported');
      await Bun.sleep(5);
    }
    await Bun.sleep(20);
    expect(rejections).toEqual([]);
  } finally {
    process.off('unhandledRejection', onRejection);
    feed.close();
    await native.stop(true);
  }
});

it.each([
  [{ type: 'provider.quota', message: 'Request failed', status: 402 }, 'insufficient_credits'],
  [{ type: 'provider.rate-limit', message: 'Request failed', status: 429 }, 'rate_limited'],
  [{ type: 'provider.rate-limit', message: 'ThrottlingException' }, 'rate_limited'],
  [{ type: 'provider.internal', message: 'Request failed', status: 503 }, 'provider_unavailable'],
  [{ type: 'provider.auth', message: 'Request failed' }, 'provider_authentication'],
  [{ type: 'unknown', message: 'Request failed' }, 'unknown'],
] as const)('classifies a native execution error by its status and type', (error, reason) => {
  expect(classifyAssistantFailure(nativeTurnError(error)).reason).toBe(reason);
});

it('restricts step starts to their message and emits each pending permission once', async () => {
  const directory = '/workspace';
  const sessionID = 'ses_local';
  const events: KiloFeedEvent[] = [];
  const activity: HarnessActivityEvent[] = [];
  let pending = [{ id: 'req_first', sessionID, action: 'shell', resources: ['pwd'] }];
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const frame = (type: string, data: Record<string, unknown>) =>
    new TextEncoder().encode(
      `data: ${JSON.stringify({ id: `evt_${type}`, type, data, created: 10, location: { directory } })}\n\n`
    );
  const native = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname === '/api/event')
        return new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              controller = stream;
              stream.enqueue(frame('server.connected', {}));
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } }
        );
      if (pathname === '/api/permission/request') return Response.json({ data: pending });
      if (pathname.endsWith('/message'))
        return Response.json({
          data: ['msg_old', 'msg_current'].map((id, index) => ({
            id,
            type: 'assistant',
            time: { created: index + 1 },
            content: [{ type: 'text', text: id }],
          })),
          cursor: { next: null },
        });
      return Response.json({
        data: { id: sessionID, location: { directory }, time: { created: 0, updated: 20 } },
      });
    },
  });
  const feed = createKilo2EventFeed({
    source: { server: { url: native.url.origin }, directory, nativeRuntimeId: 'runtime_local' },
    signal: AbortSignal.timeout(5000),
    onEvent: event => events.push(event),
    onHarnessActivity: event => activity.push(event),
    onFailure() {},
  });
  async function until(predicate: () => boolean) {
    const deadline = Date.now() + 2000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('Native event did not arrive');
      await Bun.sleep(5);
    }
  }
  const permissions = () =>
    events.filter(event => event.type === 'permission.asked').map(event => event.properties.id);
  try {
    await feed.open();
    controller?.enqueue(
      frame('session.step.started', { sessionID, assistantMessageID: 'msg_current' })
    );
    controller?.enqueue(frame('session.renamed', { sessionID }));
    await until(() => events.some(event => event.type === 'session.updated'));
    expect(
      events
        .filter(event => event.type === 'conversation.message.updated')
        .map(event => event.properties.message)
    ).toEqual([expect.objectContaining({ id: 'msg_current' })]);
    expect(activity.map(event => event.activity.type)).toEqual(['message']);
    controller?.enqueue(frame('session.step.ended', { sessionID }));
    await until(() => activity.filter(event => event.activity.type === 'part').length === 2);
    controller?.enqueue(frame('permission.asked', { sessionID, action: 'shell' }));
    await until(() => permissions().length === 1);
    pending.push({ id: 'req_second', sessionID, action: 'shell', resources: ['ls'] });
    controller?.enqueue(frame('permission.asked', { sessionID, action: 'shell' }));
    controller?.enqueue(frame('session.renamed', { sessionID }));
    await until(() => events.filter(event => event.type === 'session.updated').length === 2);
    expect(permissions()).toEqual(['req_first', 'req_second']);
    pending = [{ id: 'req_other', sessionID: 'ses_other', action: 'shell', resources: ['ls'] }];
    controller?.enqueue(frame('permission.asked', { sessionID, action: 'shell' }));
    controller?.enqueue(frame('session.renamed', { sessionID }));
    await until(() => events.filter(event => event.type === 'session.updated').length === 3);
    expect(permissions()).toEqual(['req_first', 'req_second']);
  } finally {
    feed.close();
    await native.stop(true);
  }
});
