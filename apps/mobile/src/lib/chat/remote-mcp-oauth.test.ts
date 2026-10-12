import { beforeEach, describe, expect, it, vi } from 'vitest';

import { authorizationCodeOf } from './remote-mcp-oauth';
import { remoteMcpOAuthProvider } from './remote-mcp-oauth-provider';

const { openRemoteMcpAuthorization, readRemoteMcpOAuth, writeRemoteMcpOAuth } = vi.hoisted(() => ({
  openRemoteMcpAuthorization: vi.fn<(url: string) => Promise<string | null>>(),
  readRemoteMcpOAuth: vi.fn<(id: string, url: string) => Promise<object | undefined>>(),
  writeRemoteMcpOAuth: vi.fn<(owner: object, patch: object) => Promise<void>>(),
}));

vi.mock('expo-crypto', () => ({ randomUUID: () => 'state-1' }));
vi.mock('./remote-mcp-oauth-browser', () => ({ openRemoteMcpAuthorization }));
vi.mock('./remote-mcp-oauth-store', () => ({ readRemoteMcpOAuth, writeRemoteMcpOAuth }));

const SERVER = { id: 'remote', url: 'https://remote.example/mcp' };

beforeEach(() => {
  openRemoteMcpAuthorization.mockReset();
  readRemoteMcpOAuth.mockReset().mockResolvedValue(undefined);
  writeRemoteMcpOAuth.mockReset().mockResolvedValue(undefined);
});

describe('the authorization redirect', () => {
  it('hands over the code of the request this sign-in made', () => {
    expect(authorizationCodeOf('kiloapp:///remote-mcp?code=abc&state=state-1', 'state-1')).toBe(
      'abc'
    );
  });

  it('refuses a redirect that answers another request', () => {
    expect(() =>
      authorizationCodeOf('kiloapp:///remote-mcp?code=abc&state=other', 'state-1')
    ).toThrow('another request');
  });

  it('fails with the error the authorization server sent', () => {
    expect(() =>
      authorizationCodeOf(
        'kiloapp:///remote-mcp?error=access_denied&error_description=Denied&state=state-1',
        'state-1'
      )
    ).toThrow('access_denied: Denied');
  });
});

describe('the provider discovery runs with', () => {
  it('never opens a browser or replaces the verifier a sign-in in progress made', async () => {
    const provider = remoteMcpOAuthProvider(SERVER);

    await provider.saveCodeVerifier('verifier');
    await provider.redirectToAuthorization(new URL('https://auth.example/authorize'));

    expect(openRemoteMcpAuthorization).not.toHaveBeenCalled();
    expect(writeRemoteMcpOAuth).not.toHaveBeenCalled();
    expect(provider.takeAuthorizationCode()).toBeUndefined();
  });
});

describe('the provider a sign-in runs with', () => {
  it('registers a fresh client instead of the stored one the server may have lost', async () => {
    readRemoteMcpOAuth.mockResolvedValue({ url: SERVER.url, client: { client_id: 'forgotten' } });
    const signIn = remoteMcpOAuthProvider(SERVER, { state: 'state-1', authorize: vi.fn() });

    expect(await signIn.clientInformation()).toBeUndefined();

    await signIn.saveClientInformation?.({ client_id: 'fresh', redirect_uris: [] });

    expect(await signIn.clientInformation()).toEqual({ client_id: 'fresh', redirect_uris: [] });
    expect(writeRemoteMcpOAuth).toHaveBeenCalledWith(
      expect.objectContaining(SERVER),
      expect.objectContaining({ client: expect.objectContaining({ client_id: 'fresh' }) })
    );
  });

  it('leaves discovery on the stored client', async () => {
    readRemoteMcpOAuth.mockResolvedValue({ url: SERVER.url, client: { client_id: 'stored' } });

    expect(await remoteMcpOAuthProvider(SERVER).clientInformation()).toEqual({
      client_id: 'stored',
    });
  });
});
