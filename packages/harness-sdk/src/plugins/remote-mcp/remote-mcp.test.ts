import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { Effect } from 'effect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tool, ToolCall } from '../../core/tool.js';
import {
  remoteMcpClient,
  remoteMcpTools,
  type RemoteMcpClientDeps,
  type RemoteMcpServer,
} from './index.js';

/**
 * The plugin, against a server that really speaks the protocol.
 *
 * A mocked client library would prove that this file calls the library in the
 * order this file already says it does. What is worth proving is the seam: the
 * transport really carries an `initialize`, a `tools/list` and a `tools/call`
 * over HTTP, the credential really arrives in a header, and a server that says
 * no really leaves the caller with a failure it can read. So the test runs a
 * real `node:http` server answering those messages as JSON.
 *
 * Only the test may name a Node builtin: the plugin is built for a runtime with
 * none at all, and `scripts/check-platform.ts` reads `dist/` to be sure.
 */

interface Answered {
  readonly status: number;
  readonly body?: unknown;
}

/** What the server was asked, so a claim about the wire is read off the wire. */
interface Seen {
  readonly authorization: (string | undefined)[];
}

/** The server's tools, one set per case. */
interface Tools {
  readonly list: readonly unknown[];
  call: (arguments_: Readonly<Record<string, unknown>>) => unknown;
}

/** One message off the wire. Only the fields this server answers are named. */
interface Wire {
  id?: unknown;
  method?: string;
  params?: {
    name?: string;
    arguments?: Readonly<Record<string, unknown>>;
  };
}

/** How a case wants the server to behave. */
type Mode = 'answer' | 'refuse' | 'hang';

/** One server's state, so the request handler takes one argument and not five. */
interface Fixture {
  readonly tools: Tools;
  readonly seen: Seen;
  readonly mode: Mode;
  /** How long a `tools/call` is held before it answers. */
  readonly callDelayMs: number;
}

const opened: Server[] = [];

afterAll(() => {
  for (const server of opened) {
    server.close();
  }
});

const write = (response: ServerResponse, answered: Answered): void => {
  response.writeHead(answered.status, { 'content-type': 'application/json' });
  response.end(answered.body === undefined ? '' : JSON.stringify(answered.body));
};

const reply = (id: unknown, result: unknown): Answered => ({
  status: 200,
  body: { jsonrpc: '2.0', id, result },
});

/** What the protocol says for each message this test exercises. */
const answer = (message: Wire, tools: Tools): Answered => {
  if (message.method === 'initialize') {
    return reply(message.id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'test-server', version: '0.0.0' },
    });
  }
  if (message.method === 'notifications/initialized') {
    return { status: 202 };
  }
  if (message.method === 'tools/list') {
    return reply(message.id, { tools: tools.list });
  }
  if (message.method === 'tools/call') {
    return reply(message.id, tools.call(message.params?.arguments ?? {}));
  }
  return {
    status: 200,
    body: {
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32_601, message: `no such method: ${String(message.method)}` },
    },
  };
};

/** The message this server was sent. A GET has no body, and is answered before this. */
const asWire = (raw: string): Wire => {
  const held: unknown = JSON.parse(raw);
  return typeof held === 'object' && held !== null ? held : {};
};

const bodyOf = async (request: IncomingMessage): Promise<Wire> => {
  const chunks: string[] = [];
  for await (const chunk of request) {
    chunks.push(String(chunk));
  }
  return asWire(chunks.join(''));
};

/**
 * One request, answered whole.
 *
 * A GET is the stream the protocol lets a server offer; this one offers none
 * and says so with 405, which is the answer the specification names for it.
 */
const answering = async (
  request: IncomingMessage,
  response: ServerResponse,
  fixture: Fixture
): Promise<void> => {
  fixture.seen.authorization.push(request.headers.authorization);
  if (fixture.mode === 'refuse') {
    write(response, { status: 401, body: { error: 'unauthorized' } });
    return;
  }
  if (fixture.mode === 'hang') {
    return;
  }
  if (request.method === 'GET') {
    write(response, { status: 405 });
    return;
  }
  const message = await bodyOf(request);
  /* `tools/list` still answers at once: only the call is slow, so a deadline
     that bounds discovery cannot be the one that kills the call. */
  if (message.method === 'tools/call') {
    await sleep(fixture.callDelayMs);
  }
  write(response, answer(message, fixture.tools));
};

/**
 * A server answering `initialize`, `tools/list` and `tools/call` as JSON, which
 * is the streamable transport's plain HTTP half. `refuse` makes every request a
 * 401 and `hang` answers none of them, which are the two failures the client is
 * asked to tell apart. `callDelayMs` holds a `tools/call` open, so a test can
 * ask for a call that outlives the discovery deadline.
 */
const serve = async (
  tools: Tools,
  mode: Mode = 'answer',
  callDelayMs = 0
): Promise<{ url: string; seen: Seen }> => {
  const seen: Seen = { authorization: [] };
  const fixture: Fixture = { tools, seen, mode, callDelayMs };
  const server = createServer((request, response) => {
    void answering(request, response, fixture);
  });
  opened.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the test server took no port');
  }
  return { url: `http://127.0.0.1:${String(address.port)}/mcp`, seen };
};

const serverFor = (id: string, url: string, bearer: string): RemoteMcpServer => ({
  id,
  name: 'Test server',
  url,
  auth: bearer === '' ? { type: 'none' } : { type: 'bearer' },
});

/** A secret no server should be able to read off the wire by accident. */
const token = 'token-for-the-test';

/**
 * The deps one case runs with. `timeoutMs` is the deadline of every operation;
 * `discoverTimeoutMs` is the deadline of discovery alone, and a case that sets
 * only that is proving a call keeps the harness's own bound.
 */
const deps = (
  fields: { readonly timeoutMs?: number; readonly discoverTimeoutMs?: number } = {}
): RemoteMcpClientDeps => ({
  fetch,
  token: () => Effect.succeed(token),
  ...(fields.timeoutMs === undefined ? {} : { timeoutMs: fields.timeoutMs }),
  ...(fields.discoverTimeoutMs === undefined
    ? {}
    : { discoverTimeoutMs: fields.discoverTimeoutMs }),
});

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

const callOf = (name: string, arguments_: string): ToolCall => ({
  id: 'call_1',
  name,
  arguments: arguments_,
});

/** The one tool of a list, or a failure that says the list is not what was asked for. */
const only = (tools: readonly Tool[]): Tool => {
  const [first] = tools;
  if (first === undefined) {
    throw new Error('the server offered no tool');
  }
  return first;
};

const readingFile: Tools = {
  list: [
    {
      name: 'read-file',
      description: 'Reads one file.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    },
  ],
  call: arguments_ => ({ content: [{ type: 'text', text: `read ${String(arguments_['path'])}` }] }),
};

/** The server the discovery cases share. */
const fixture: { url: string; seen: Seen } = { url: '', seen: { authorization: [] } };

describe('discovering a remote server', () => {
  beforeAll(async () => {
    const served = await serve(readingFile);
    fixture.url = served.url;
    fixture.seen = served.seen;
  });

  it('names each tool after its server', async () => {
    const offered = await run(remoteMcpTools(serverFor('work', fixture.url, token), deps()));
    expect(offered.map(tool => tool.definition.name)).toEqual(['mcp_work_read-file']);
    expect(only(offered).definition.parameters).toEqual({
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
    });
    expect(only(offered).definition.description).toBe('Reads one file.');
  });

  it('carries the credential as a bearer header', async () => {
    fixture.seen.authorization.length = 0;
    await run(remoteMcpClient(serverFor('work', fixture.url, token), deps()).tools);
    expect(fixture.seen.authorization).toContain(`Bearer ${token}`);
  });

  it('asks the credential source again for every operation', async () => {
    fixture.seen.authorization.length = 0;
    let minted = 0;
    const rotating: RemoteMcpClientDeps = {
      fetch,
      token: () => Effect.sync(() => `token-${String((minted += 1))}`),
    };
    await run(remoteMcpClient(serverFor('work', fixture.url, token), rotating).tools);
    await run(remoteMcpClient(serverFor('work', fixture.url, token), rotating).tools);
    expect(fixture.seen.authorization).toContain('Bearer token-1');
    expect(fixture.seen.authorization).toContain('Bearer token-2');
  });

  it('answers a call with the server’s text', async () => {
    const offered = await run(remoteMcpTools(serverFor('work', fixture.url, token), deps()));
    const answered = await run(
      only(offered).run(callOf('mcp_work_read-file', '{"path":"/tmp/answer"}'))
    );
    expect(answered).toBe('read /tmp/answer');
  });
});

describe('a remote server that says no', () => {
  it('is unauthorized when the server refuses the credential', async () => {
    const refused = await serve({ list: [], call: () => ({}) }, 'refuse');
    const error = await run(
      Effect.flip(remoteMcpClient(serverFor('work', refused.url, ''), deps()).tools)
    );
    expect(error.kind).toBe('unauthorized');
    expect(error.serverId).toBe('work');
  });

  it('gives up on a server that stops answering', async () => {
    const silent = await serve({ list: [], call: () => ({}) }, 'hang');
    const error = await run(
      Effect.flip(
        remoteMcpClient(serverFor('work', silent.url, ''), deps({ timeoutMs: 50 })).tools
      )
    );
    expect(error.kind).toBe('unreachable');
  });

  it('bounds discovery by its own deadline, not by the call’s', async () => {
    const silent = await serve({ list: [], call: () => ({}) }, 'hang');
    const error = await run(
      Effect.flip(
        remoteMcpClient(serverFor('work', silent.url, ''), deps({ discoverTimeoutMs: 50 })).tools
      )
    );
    expect(error.kind).toBe('unreachable');
  });

  it('lets a call outlive the discovery deadline and still answer', async () => {
    /* Discovery answers at once and the call sleeps 600 ms, which is past the
       200 ms discovery deadline. The call keeps the harness's own bound, so the
       server's text is the answer rather than a failure at the chat-open one. */
    const slow = await serve(readingFile, 'answer', 600);
    const offered = await run(
      remoteMcpTools(serverFor('work', slow.url, token), deps({ discoverTimeoutMs: 200 }))
    );
    const answered = await run(
      only(offered).run(callOf('mcp_work_read-file', '{"path":"/tmp/slow"}'))
    );
    expect(answered).toBe('read /tmp/slow');
  });

  it('fails the tool, not the session, when the server refuses the call', async () => {
    const refusing = await serve({
      list: [{ name: 'deny', inputSchema: { type: 'object', properties: {} } }],
      call: () => ({ content: [{ type: 'text', text: 'the file is not there' }], isError: true }),
    });
    const offered = await run(remoteMcpTools(serverFor('work', refusing.url, ''), deps()));
    const failed = await run(Effect.flip(only(offered).run(callOf('mcp_work_deny', '{}'))));
    expect(String(failed.cause)).toBe('the file is not there');
  });
});
