import { Effect } from 'effect';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  remoteMcpClient,
  remoteMcpTools,
  type RemoteMcpClientDeps,
  type RemoteMcpError,
} from './index.js';
import {
  callOf,
  deps,
  noTools,
  only,
  readingFile,
  run,
  schema,
  serve,
  serverFor,
  token,
  type Seen,
} from './remote-mcp-fixture.js';

/**
 * The plugin against the server in `remote-mcp-fixture.ts`: discovery, the
 * credential it carries, a call, and what a server that says no leaves behind.
 * The fixture holds the protocol; these are the claims.
 */

const fixture: { url: string; seen: Seen } = { url: '', seen: { authorization: [] } };

describe('discovering a remote server', () => {
  beforeAll(async () => {
    const served = await serve(readingFile);
    fixture.url = served.url;
    fixture.seen = served.seen;
  });

  it('names each tool after its server', async () => {
    const offered = await run(remoteMcpTools(serverFor('work', fixture.url, token), deps()));
    const [first] = offered;
    expect(first?.definition.name).toBe('mcp_work_read-file');
    expect(first?.definition.parameters).toEqual(schema);
    expect(first?.definition.description).toBe('Reads one file.');
  });

  it('reads the credential source for every operation, as a bearer header', async () => {
    fixture.seen.authorization.length = 0;
    let minted = 0;
    const rotating: RemoteMcpClientDeps = {
      fetch,
      token: () => Effect.sync(() => `token-${String((minted += 1))}`),
    };
    await run(remoteMcpClient(serverFor('work', fixture.url, token), deps()).tools);
    await run(remoteMcpClient(serverFor('work', fixture.url, token), rotating).tools);
    await run(remoteMcpClient(serverFor('work', fixture.url, token), rotating).tools);
    expect(fixture.seen.authorization).toContain(`Bearer ${token}`);
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
    const refused = await serve(noTools, 'refuse');
    const error = await run(
      Effect.flip(remoteMcpClient(serverFor('work', refused.url, ''), deps()).tools)
    );
    expect(error.kind).toBe('unauthorized');
    expect(error.serverId).toBe('work');
  });

  it.each([
    { bounded: 'the per-operation deadline', fields: { timeoutMs: 50 } },
    { bounded: 'the discovery deadline', fields: { discoverTimeoutMs: 50 } },
  ])('gives up on a server that stops answering, bounded by $bounded', async ({ fields }) => {
    const hanging = await serve(noTools, 'hang');
    const error = await run(
      Effect.flip(remoteMcpClient(serverFor('work', hanging.url, ''), deps(fields)).tools)
    );
    expect(error.kind).toBe('unreachable');
  });

  it('holds a credential that never arrives to the same deadline', async () => {
    const silent: RemoteMcpClientDeps = {
      ...deps({ discoverTimeoutMs: 50 }),
      token: () => Effect.never,
    };
    const error = await run(
      Effect.flip(remoteMcpClient(serverFor('work', fixture.url, token), silent).tools)
    );
    expect(error.kind).toBe('unreachable');
  });
});

describe('a call', () => {
  it('outlives the discovery deadline and still answers', async () => {
    /* Discovery answers at once and the call sleeps 600 ms, past the 200 ms
       discovery deadline. The call keeps the harness's own bound, so the
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

  it('fails the tool, not the session, when the server refuses it', async () => {
    const refusing = await serve({
      list: [{ name: 'deny', inputSchema: { type: 'object', properties: {} } }],
      call: () => ({ content: [{ type: 'text', text: 'the file is not there' }], isError: true }),
    });
    const offered = await run(remoteMcpTools(serverFor('work', refusing.url, ''), deps()));
    const failed = await run(Effect.flip(only(offered).run(callOf('mcp_work_deny', '{}'))));
    expect(String(failed.cause)).toBe('the file is not there');
  });
});

describe('reporting a call that did not reach the server', () => {
  it('hands it to the surface, because a tool result never reaches a screen', async () => {
    const down = await serve(readingFile, 'refuse-call');
    const failures: RemoteMcpError[] = [];
    const offered = await run(
      remoteMcpTools(serverFor('work', down.url, token), {
        ...deps(),
        onCallFailure: error => failures.push(error),
      })
    );
    await run(Effect.flip(only(offered).run(callOf('mcp_work_read-file', '{"path":"/x"}'))));
    expect(failures.map(error => error.kind)).toEqual(['unreachable']);
    expect(failures[0]?.serverId).toBe('work');
  });

  it('hands over a credential the server refused on a call', async () => {
    /* Discovery answers, then the server refuses the call's credential. The
       failure is the connection's, so the surface hears about it; the model
       still gets the failed result. */
    const refused = await serve(readingFile, 'refuse-call-auth');
    const failures: RemoteMcpError[] = [];
    const offered = await run(
      remoteMcpTools(serverFor('work', refused.url, token), {
        ...deps(),
        onCallFailure: error => failures.push(error),
      })
    );
    const failed = await run(
      Effect.flip(only(offered).run(callOf('mcp_work_read-file', '{"path":"/y"}')))
    );
    expect(failures.map(error => error.kind)).toEqual(['unauthorized']);
    expect(String(failed.cause)).toContain('refused');
  });

  it('does not report a call the server itself refused', async () => {
    const refusing = await serve({
      list: [{ name: 'deny', inputSchema: { type: 'object', properties: {} } }],
      call: () => ({ content: [{ type: 'text', text: 'the file is not there' }], isError: true }),
    });
    const failures: RemoteMcpError[] = [];
    const offered = await run(
      remoteMcpTools(serverFor('work', refusing.url, ''), {
        ...deps(),
        onCallFailure: error => failures.push(error),
      })
    );
    await run(Effect.flip(only(offered).run(callOf('mcp_work_deny', '{}'))));
    expect(failures).toEqual([]);
  });
});
