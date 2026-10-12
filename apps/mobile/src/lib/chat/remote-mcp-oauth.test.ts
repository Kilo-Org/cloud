import { beforeEach, describe, expect, it, vi } from 'vitest';

import { authorizationCodeOf } from './remote-mcp-oauth';
import { remoteMcpOAuthProvider } from './remote-mcp-oauth-provider';

const { openRemoteMcpAuthorization, writeRemoteMcpOAuth } = vi.hoisted(() => ({
  openRemoteMcpAuthorization: vi.fn<(url: string) => Promise<string | null>>(),
  writeRemoteMcpOAuth: vi.fn<(id: string, url: string, patch: object) => Promise<void>>(),
}));

vi.mock('expo-crypto', () => ({ randomUUID: () => 'state-1' }));
vi.mock('./remote-mcp-oauth-browser', () => ({ openRemoteMcpAuthorization }));
vi.mock('./remote-mcp-oauth-store', () => ({
  readRemoteMcpOAuth: vi.fn().mockResolvedValue(undefined),
  writeRemoteMcpOAuth,
}));

beforeEach(() => {
  openRemoteMcpAuthorization.mockReset();
  writeRemoteMcpOAuth.mockReset();
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
    const provider = remoteMcpOAuthProvider({ id: 'remote', url: 'https://remote.example/mcp' });

    await provider.saveCodeVerifier('verifier');
    await provider.redirectToAuthorization(new URL('https://auth.example/authorize'));

    expect(openRemoteMcpAuthorization).not.toHaveBeenCalled();
    expect(writeRemoteMcpOAuth).not.toHaveBeenCalled();
    expect(provider.takeAuthorizationCode()).toBeUndefined();
  });
});
