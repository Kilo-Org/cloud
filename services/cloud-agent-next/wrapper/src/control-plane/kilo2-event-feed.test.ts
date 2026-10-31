import { expect, it } from 'bun:test';
import { createKilo2EventFeed } from './kilo2-event-feed.js';
import type { KiloFeedEvent } from './kilo-event-feed.js';

it('does not acknowledge a later prompt from an earlier interrupted execution snapshot', async () => {
  const directory = '/workspace';
  const sessionID = 'ses_local';
  const events: KiloFeedEvent[] = [];
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
    expect(events.some(event => event.type === 'message.updated')).toBe(false);
    const idle = events.findIndex(event => event.type === 'session.status');
    const close = events.findIndex(event => event.type === 'session.turn.close');
    expect(idle).toBeLessThan(close);
    controller?.enqueue(frame('session.execution.started', { sessionID }, 21));
    controller?.enqueue(frame('session.inbox.delivered', { sessionID, inboxID: 'msg_next' }, 22));
    await until(() => events.some(event => event.type === 'message.updated'));
    expect(
      events.filter(event => event.type === 'message.updated').map(event => event.properties.info)
    ).toMatchObject([{ id: 'msg_next' }]);
  } finally {
    feed.close();
    await native.stop(true);
  }
});
