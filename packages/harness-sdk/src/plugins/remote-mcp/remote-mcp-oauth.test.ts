import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { remoteMcpClient, remoteMcpSignIn, remoteMcpTools } from './index.js';
import { callOf, only, run } from './remote-mcp-fixture.js';
import { memoryProvider, oauthServerFor, serveOAuth } from './remote-mcp-oauth-fixture.js';

describe('signing in to an OAuth server', () => {
  it('is asked for before a person has signed in', async () => {
    const served = await serveOAuth();
    const error = await run(
      Effect.flip(
        remoteMcpClient(oauthServerFor(served.url), { fetch, authProvider: memoryProvider() }).tools
      )
    );
    expect(error.kind).toBe('unauthorized');
  });

  it('lists and calls tools once a person signs in', async () => {
    const served = await serveOAuth();
    const server = oauthServerFor(served.url);
    const authProvider = memoryProvider();
    await run(remoteMcpSignIn(server, { fetch, authProvider }));
    const offered = await run(remoteMcpTools(server, { fetch, authProvider }));
    const answered = await run(
      only(offered).run(callOf('mcp_work_read-file', '{"path":"/tmp/signed-in"}'))
    );
    expect(answered).toBe('read /tmp/signed-in');
  });

  it('fails when the person turned back', async () => {
    const served = await serveOAuth();
    const error = await run(
      Effect.flip(
        remoteMcpSignIn(oauthServerFor(served.url), {
          fetch,
          authProvider: memoryProvider({ turnsBack: true }),
        })
      )
    );
    expect(error.kind).toBe('unauthorized');
  });
});

describe('an OAuth token the server stopped accepting', () => {
  it('is refreshed with no person involved', async () => {
    const served = await serveOAuth();
    const server = oauthServerFor(served.url);
    const authProvider = memoryProvider();
    await run(remoteMcpSignIn(server, { fetch, authProvider }));
    const first = authProvider.saved()?.access_token;
    served.revokeAccess();
    const tools = await run(remoteMcpClient(server, { fetch, authProvider }).tools);
    expect(tools.map(tool => tool.name)).toEqual(['read-file']);
    expect(authProvider.saved()?.access_token).not.toBe(first);
  });

  it('asks for a sign-in again once the refresh is refused, and works after it', async () => {
    const served = await serveOAuth();
    const server = oauthServerFor(served.url);
    const authProvider = memoryProvider();
    await run(remoteMcpSignIn(server, { fetch, authProvider }));
    served.revokeAll();
    const refused = await run(Effect.flip(remoteMcpClient(server, { fetch, authProvider }).tools));
    expect(refused.kind).toBe('unauthorized');
    await run(remoteMcpSignIn(server, { fetch, authProvider }));
    const tools = await run(remoteMcpClient(server, { fetch, authProvider }).tools);
    expect(tools.map(tool => tool.name)).toEqual(['read-file']);
  });
});
