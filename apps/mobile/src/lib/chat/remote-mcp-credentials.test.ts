import { Effect } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RemoteMcpError } from '@kilocode/harness-sdk/plugins/remote-mcp';

import { credentialDeps } from './remote-mcp-credentials';
import { type StoredRemoteMcpServer } from './remote-mcp-store';

/**
 * The credential one server's discovery carries.
 *
 * A value is saved for one endpoint, so the accessor reads the stored entry by
 * id and endpoint: a value that belongs to another endpoint is refused rather
 * than handed to the host this discovery is talking to.
 */

const world = vi.hoisted(() => ({ servers: [] as StoredRemoteMcpServer[] }));

vi.mock('./remote-mcp-store', () => ({ listRemoteMcpServers: () => world.servers }));

const { oauthProvider } = vi.hoisted(() => ({ oauthProvider: { redirectUrl: 'kiloapp:///x' } }));
vi.mock('./remote-mcp-oauth-provider', () => ({ remoteMcpOAuthProvider: () => oauthProvider }));

function server(fields: Partial<StoredRemoteMcpServer> = {}): StoredRemoteMcpServer {
  return {
    id: 'beta',
    name: 'Beta',
    url: 'https://beta.example/mcp',
    auth: { type: 'bearer', token: 'secret' },
    enabled: true,
    ...fields,
  };
}

/** What the accessor of a bearer server answers, as the SDK asks it. */
function readToken(
  fields: Partial<StoredRemoteMcpServer> = {}
): Effect.Effect<string, RemoteMcpError> {
  const { token } = credentialDeps(server(fields));
  if (token === undefined) {
    throw new Error('the bearer server handed over no token accessor');
  }
  return token();
}

beforeEach(() => {
  world.servers = [];
});

describe('the credential one discovery carries', () => {
  it('reads the value saved for this endpoint', async () => {
    world.servers = [server()];

    expect(await Effect.runPromise(readToken())).toBe('secret');
  });

  it('refuses the value once the stored entry names another endpoint', async () => {
    world.servers = [
      server({ url: 'https://elsewhere.example/mcp', auth: { type: 'bearer', token: 'moved' } }),
    ];

    const error = await Effect.runPromise(Effect.flip(readToken()));

    expect(error).toBeInstanceOf(RemoteMcpError);
    expect(error.kind).toBe('unauthorized');
  });

  it('refuses a bearer server whose stored value is gone', async () => {
    world.servers = [server({ auth: { type: 'bearer' } })];

    const error = await Effect.runPromise(Effect.flip(readToken()));

    expect(error).toBeInstanceOf(RemoteMcpError);
    expect(error.kind).toBe('unauthorized');
  });

  it('hands an OAuth server its provider and no stored value', () => {
    const oauth = server({ auth: { type: 'oauth' } });
    world.servers = [oauth];

    expect(credentialDeps(oauth)).toEqual({ authProvider: oauthProvider });
  });

  it('carries nothing for a server that wants no credential', () => {
    expect(credentialDeps(server({ auth: { type: 'none' } }))).toEqual({});
  });
});
