import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { Effect } from 'effect';
import { afterAll } from 'vitest';
import type { Tool, ToolCall } from '../../core/tool.js';
import { type RemoteMcpClientDeps, type RemoteMcpServer } from './index.js';

/**
 * A server that really speaks the protocol, for the remote MCP suite.
 *
 * The transport carries an `initialize`, a `tools/list` and a `tools/call` over
 * HTTP, the credential arrives in a header, and a server that says no leaves a
 * failure the caller can read. It is a fixture rather than a test because two
 * files hold claims about it, and only this file may name a Node builtin —
 * `check-platform.ts` reads `dist/` to be sure the plugin itself names none.
 */

/** A response, whole: a status and, for one that answered, its body. */
type Answered = readonly [status: number, body?: unknown];

interface Seen {
  readonly authorization: (string | undefined)[];
}

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

/** One server's state, so the request handler takes one argument and not five. */
interface Fixture {
  readonly tools: Tools;
  readonly seen: Seen;
  readonly mode: 'answer' | 'refuse' | 'refuse-call' | 'refuse-call-auth' | 'hang';
  /** How long a `tools/call` is held before it answers. */
  readonly callDelayMs: number;
}

const opened: Server[] = [];

afterAll(() => {
  for (const server of opened) {
    server.close();
  }
});

const write = (response: ServerResponse, [status, body]: Answered): void => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(body === undefined ? '' : JSON.stringify(body));
};

const reply = (id: unknown, result: unknown): Answered => [200, { jsonrpc: '2.0', id, result }];

/** What a `tools/call` is answered with before its own tool: a server that is
    down, or one that refuses the credential. */
const refusedCall = (fixture: Fixture): Answered | undefined => {
  if (fixture.mode === 'refuse-call') {
    return [500, { error: 'the call failed' }];
  }
  if (fixture.mode === 'refuse-call-auth') {
    return [401, { error: 'unauthorized' }];
  }
  return undefined;
};

/** What the protocol says for each message this server exercises. */
const answer = (message: Wire, fixture: Fixture): Answered => {
  if (message.method === 'initialize') {
    return reply(message.id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'test-server', version: '0.0.0' },
    });
  }
  if (message.method === 'notifications/initialized') {
    return [202];
  }
  if (message.method === 'tools/list') {
    return reply(message.id, { tools: fixture.tools.list });
  }
  if (message.method === 'tools/call') {
    const refused = refusedCall(fixture);
    return refused ?? reply(message.id, fixture.tools.call(message.params?.arguments ?? {}));
  }
  return [
    200,
    {
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32_601, message: `no such method: ${String(message.method)}` },
    },
  ];
};

const bodyOf = async (request: IncomingMessage): Promise<Wire> => {
  const chunks: string[] = [];
  for await (const chunk of request) {
    chunks.push(String(chunk));
  }
  const held: unknown = JSON.parse(chunks.join(''));
  return typeof held === 'object' && held !== null ? held : {};
};

/** What the mode answers before a message is read: `refuse` a 401 for everything,
    `hang` nothing, and a GET is the stream this server does not offer. */
const beforeBody = (request: IncomingMessage, fixture: Fixture): Answered | 'hang' | undefined => {
  if (fixture.mode === 'refuse') {
    return [401, { error: 'unauthorized' }];
  }
  if (fixture.mode === 'hang') {
    return 'hang';
  }
  return request.method === 'GET' ? [405] : undefined;
};

/** One request, answered whole. `tools/list` answers at once and only a
    `tools/call` is held, so discovery's deadline cannot be the call's. */
const answering = async (
  request: IncomingMessage,
  response: ServerResponse,
  fixture: Fixture
): Promise<void> => {
  fixture.seen.authorization.push(request.headers.authorization);
  const decided = beforeBody(request, fixture);
  if (decided !== undefined) {
    if (decided !== 'hang') {
      write(response, decided);
    }
    return;
  }
  const message = await bodyOf(request);
  if (message.method === 'tools/call') {
    await sleep(fixture.callDelayMs);
  }
  write(response, answer(message, fixture));
};

/**
 * A server answering `initialize`, `tools/list` and `tools/call` as JSON, which
 * is the streamable transport's plain HTTP half. `callDelayMs` holds a
 * `tools/call` open, so a test can ask for a call that outlives the discovery
 * deadline the same server answered at once.
 */
const serve = async (
  tools: Tools,
  mode: Fixture['mode'] = 'answer',
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

const token = 'token-for-the-test';

/**
 * The deps one case runs with. `timeoutMs` is every operation's deadline;
 * `discoverTimeoutMs` is discovery's alone.
 */
const deps = (
  fields: { readonly timeoutMs?: number; readonly discoverTimeoutMs?: number } = {}
): RemoteMcpClientDeps => ({ fetch, token: () => Effect.succeed(token), ...fields });

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

const callOf = (name: string, arguments_: string): ToolCall => ({
  id: 'call_1',
  name,
  arguments: arguments_,
});

const only = (tools: readonly Tool[]): Tool => {
  const [first] = tools;
  if (first === undefined) {
    throw new Error('the server offered no tool');
  }
  return first;
};

const schema = {
  type: 'object',
  properties: { path: { type: 'string' } },
  required: ['path'],
  additionalProperties: false,
};

const readingFile: Tools = {
  list: [{ name: 'read-file', description: 'Reads one file.', inputSchema: schema }],
  call: arguments_ => ({ content: [{ type: 'text', text: `read ${String(arguments_['path'])}` }] }),
};

const noTools: Tools = { list: [], call: () => ({}) };

export type { Answered, Fixture, Seen, Tools, Wire };
export { callOf, deps, noTools, only, readingFile, run, schema, serve, serverFor, token };
