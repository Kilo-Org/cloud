import { browserCapabilityHeader } from './browser-capability';

function tokenWithClaims(claims: Record<string, unknown>): string {
  const payload = btoa(JSON.stringify(claims))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `header.${payload}.signature`;
}

const adminToken = tokenWithClaims({ isAdmin: true, kiloUserId: 'user-1' });
const userToken = tokenWithClaims({ isAdmin: false, kiloUserId: 'user-1' });

describe('browserCapabilityHeader', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  function params(operations: Array<{ path: string; input: unknown }>, token = adminToken) {
    return {
      audience: 'gastown-admin' as const,
      operations,
      getIdentityToken: async () => token,
      tokenEndpoint: '/api/gastown/token' as const,
    };
  }

  it('returns null for non-admin identities without calling the issuer', async () => {
    await expect(
      browserCapabilityHeader(
        params([{ path: 'gastown.getTown', input: { townId: 'town-1' } }], userToken)
      )
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requests a capability for a single-town batch and caches it', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          capability: 'cap-1',
          capabilityExpiresAt: new Date(Date.now() + 300_000).toISOString(),
        }),
        { status: 200 }
      )
    );
    const request = params([{ path: 'gastown.getTown', input: { townId: 'town-1' } }]);
    await expect(browserCapabilityHeader(request)).resolves.toBe('cap-1');
    await expect(browserCapabilityHeader(request)).resolves.toBe('cap-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toEqual({
      adminCapability: {
        target: { kind: 'town', id: 'town-1' },
        actions: ['trpc:gastown.getTown'],
      },
    });
  });

  it('does not attach a capability across mixed targets', async () => {
    await expect(
      browserCapabilityHeader(
        params([
          { path: 'gastown.getTown', input: { townId: 'town-1' } },
          { path: 'gastown.getRig', input: { townId: 'town-2', rigId: 'rig-1' } },
        ])
      )
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to null when issuance is unavailable', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 403 }));
    await expect(
      browserCapabilityHeader(params([{ path: 'gastown.getTown', input: { townId: 'town-3' } }]))
    ).resolves.toBeNull();
  });
});
