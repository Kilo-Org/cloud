import { expect, it, onTestFinished, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker-provider.js';
import { createMcpTransportFactory } from './mcp-transport';
import { mcpTestFixture } from './mcp-test-fixture';

const closed = new McpError(ErrorCode.ConnectionClosed, 'Connection closed');
const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' } as const;
const call = (args: object) => ({
  ...list,
  method: 'tools/call',
  params: { name: 'remote', arguments: args },
});
const reply = (body: BodyInit, type = 'application/json') =>
  new Response(body, { headers: { 'Content-Type': type } });
const streamReply = (source: UnderlyingSource<Uint8Array>, type = 'application/json') =>
  reply(new ReadableStream(source), type);
const sseData = (message: object) => `data: ${JSON.stringify(message)}\n\n`;
function fixture(httpResponseBytes = 4096, signal?: AbortSignal) {
  const provider = mcpTestFixture();
  const abort = new AbortController();
  const factory = createMcpTransportFactory(
    signal ? AbortSignal.any([abort.signal, signal]) : abort.signal,
    httpResponseBytes,
    reason => {
      throw new Error(reason);
    },
    provider.fetchImpl
  );
  return {
    ...provider,
    abort,
    transport(connection = provider.connection) {
      const transport = factory(connection);
      onTestFinished(() => transport.close());
      return transport;
    },
    async client(transport = this.transport()) {
      const client = new Client(
        { name: 'test', version: '1' },
        { jsonSchemaValidator: new CfWorkerJsonSchemaValidator() }
      );
      await client.connect(transport);
      return client;
    },
  };
}

it.each([
  [401, 'reauthorization_required'],
  [403, 'reauthorization_required'],
  [503, 'unavailable_server'],
  [302, 'unsafe_destination'],
  [307, 'unsafe_destination'],
  [308, 'unsafe_destination'],
  [400, 'unsafe_destination'],
  ['redirected', 'unsafe_destination'],
  ['url', 'unsafe_destination'],
  ['lose', 'unavailable_server'],
  ['body', 'unavailable_server'],
  ['json', 'unavailable_server'],
] as const)('sanitizes %s without retrying a mutation', async (mode, reason) => {
  const f = fixture();
  if (typeof mode === 'number') f.state.status = mode;
  f.state.lose = mode === 'lose';
  if (mode === 'redirected' || mode === 'url') {
    f.state.response = reply('{}');
    Object.defineProperty(f.state.response, mode, {
      value: mode === 'url' ? 'https://other.example' : true,
    });
  }
  if (mode === 'body')
    f.state.response = streamReply({
      start(controller) {
        controller.error(new Error('provider-secret'));
      },
    });
  if (mode === 'json') f.state.response = reply('provider-secret');
  const transport = f.transport();
  const errors: string[] = [];
  transport.onerror = error => errors.push(error.message);
  await transport.start();
  await expect(transport.send(call({}))).rejects.toThrow(reason);
  expect(errors).toEqual([reason]);
  expect(f.state.requests).toHaveLength(1);
  expect(f.state.effects).toEqual(typeof mode === 'number' ? [] : [{}]);
});

it.each([
  'not a URL',
  'http://gateway.example',
  'https://user:secret@gateway.example',
  'https://gateway.example?secret',
  'https://gateway.example#secret',
])('rejects unsafe URL %s', url => {
  const f = fixture();
  expect(() => f.transport({ ...f.connection, url })).toThrow('unsafe_destination');
  expect(f.state.requests).toEqual([]);
});

it('uses SDK initialization, discovery, and calls without changing the authorized destination', async () => {
  const f = fixture();
  const transport = f.transport();
  const destination = f.connection.url;
  f.connection.url = 'https://other.example';
  f.connection.authorization = 'Bearer replacement';
  const client = await f.client(transport);
  expect(await client.listTools()).toEqual({ tools: [f.state.tool] });
  expect(await client.callTool(call({ [f.key]: 2 }).params)).toEqual(f.state.result);
  f.state.response = message =>
    reply(sseData({ ...message, result: { tools: [] } }), 'text/event-stream');
  expect(await client.listTools()).toEqual({ tools: [] });
  expect(f.state.effects).toEqual([{ [f.key]: 2 }]);
  for (const { url, init } of f.state.requests) {
    expect(url).toBe(destination);
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer derived-secret');
    expect(new Headers(init.headers).get('accept')).toContain('text/event-stream');
  }
  expect(f.state.requests.some(({ init }) => init.method === 'GET')).toBe(true);
});

it.each(['cancel', 'fetch', 'disconnected', 'body', 'json', 'envelope'])(
  'rejects %s requests and blocks the failed operation',
  async mode => {
    const f = fixture();
    const secondConnection = { ...f.connection, url: `${f.connection.url}/second` };
    const transports = [f.transport(), f.transport(secondConnection)];
    const clients = await Promise.all(transports.map(transport => f.client(transport)));
    const streams: [ReadableStreamDefaultController<Uint8Array>, object][] = [];
    f.state.stall = mode === 'fetch';
    f.state.response = message =>
      streamReply(
        {
          start(controller) {
            streams.push([controller, message]);
          },
        },
        'text/event-stream'
      );
    const args = { [f.key]: 2 };
    const pending = Promise.allSettled(clients.map(client => client.callTool(call(args).params)));
    await vi.waitFor(() => expect(f.state.effects).toEqual([args, args]));
    const requests = f.state.requests.length;
    const secret = 'provider-secret https://user:secret@gateway.example Bearer derived-secret';
    if (mode === 'cancel' || mode === 'fetch') f.abort.abort(new Error(secret));
    else {
      const stream = streams[0];
      if (!stream) throw new Error('Missing SSE request');
      const [controller, message] = stream;
      if (mode === 'body') controller.error(new Error(secret));
      else {
        const data =
          mode === 'disconnected'
            ? 'id: resume\nevent: ping\ndata: {}\nretry: 1\n\n'
            : `data: ${mode === 'json' ? secret : '{}'}\n\n${sseData(message)}`;
        controller.enqueue(new TextEncoder().encode(data));
        controller.close();
      }
    }
    for (const outcome of await pending)
      expect(outcome).toEqual({ status: 'rejected', reason: closed });
    for (const transport of transports)
      await expect(transport.send(call(args))).rejects.toThrow('unavailable_server');
    expect(() => f.transport()).toThrow('unavailable_server');
    expect(f.state.effects).toEqual([args, args]);
    expect(f.state.requests).toHaveLength(requests);
  },
  1000
);

it('shares streamed UTF-8 bytes across connections and cancels overflow before parsing', async () => {
  const f = fixture(1100);
  const first = f.transport();
  const second = f.transport({ ...f.connection, url: `${f.connection.url}/second` });
  const messages: unknown[] = [];
  first.onmessage = second.onmessage = message => messages.push(message);
  await first.start();
  await second.start();
  await first.send(list);
  expect(messages).toEqual([{ jsonrpc: '2.0', id: 1, result: { tools: [f.state.tool] } }]);
  let cancelled = false,
    chunks = 0;
  f.state.response = streamReply({
    pull(controller) {
      if (++chunks <= 5) controller.enqueue(new TextEncoder().encode('é'.repeat(100)));
      else controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  f.state.response.headers.set('Content-Length', '1');
  await expect(second.send(list)).rejects.toThrow('limit_exceeded');
  await vi.waitFor(() => expect(cancelled).toBe(true));
  expect(messages).toHaveLength(1);
  expect(() => f.transport()).toThrow('limit_exceeded');
});

it.each(['fetch', 'body', 'sse', 'initialize', 'aborted'])(
  'honors the caller deadline during %s',
  async phase => {
    const f = fixture(4096, phase === 'aborted' ? AbortSignal.abort() : AbortSignal.timeout(50));
    const initializing = phase === 'initialize' || phase === 'aborted';
    const client = initializing ? undefined : await f.client();
    f.state.stall = phase === 'fetch';
    const streamed = phase === 'body' || phase === 'sse' || phase === 'initialize';
    let cancelled = false;
    if (streamed)
      f.state.response = streamReply(
        {
          cancel() {
            cancelled = true;
          },
        },
        phase === 'body' ? 'application/json' : 'text/event-stream'
      );
    const pending = client ? client.callTool(call({}).params) : f.client();
    await expect(pending).rejects.toEqual(closed);
    expect(f.state.effects).toEqual(initializing ? [] : [{}]);
    if (streamed) expect(cancelled).toBe(true);
  },
  1000
);
