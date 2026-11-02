import {
  browserCapabilityHeader,
  resetBrowserCapabilityCache,
  type BrowserWorkerIdentity,
} from './browser-capability';

const adminIdentity: BrowserWorkerIdentity = {
  token: 'identity-token',
  admin: true,
  capabilityIssuance: true,
};

const nonAdminIdentity: BrowserWorkerIdentity = { ...adminIdentity, admin: false };
const legacyIdentity: BrowserWorkerIdentity = { ...adminIdentity, capabilityIssuance: false };

describe('browserCapabilityHeader', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
    resetBrowserCapabilityCache();
  });

  function params(
    operations: Array<{ path: string; input: unknown }>,
    identity: BrowserWorkerIdentity = adminIdentity
  ) {
    return {
      audience: 'gastown-admin' as const,
      operations,
      getIdentity: async () => identity,
      tokenEndpoint: '/api/gastown/token' as const,
    };
  }

  it('does nothing for non-admin identities', async () => {
    await expect(
      browserCapabilityHeader(
        params([{ path: 'gastown.getTown', input: { townId: 'town-1' } }], nonAdminIdentity)
      )
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does nothing at the default flags, so no extra request is made', async () => {
    await expect(
      browserCapabilityHeader(
        params([{ path: 'gastown.getTown', input: { townId: 'town-1' } }], legacyIdentity)
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

  it('negative-caches issuance failures so polling does not retry each time', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 403 }));
    const request = params([{ path: 'gastown.getTown', input: { townId: 'town-3' } }]);
    await expect(browserCapabilityHeader(request)).resolves.toBeNull();
    await expect(browserCapabilityHeader(request)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
