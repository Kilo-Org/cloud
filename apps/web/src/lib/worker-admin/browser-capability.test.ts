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

  it('drops unlisted actions instead of poisoning the target cache', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          capability: 'cap-1',
          capabilityExpiresAt: new Date(Date.now() + 300_000).toISOString(),
        }),
        { status: 200 }
      )
    );
    await expect(
      browserCapabilityHeader(
        params([
          { path: 'gastown.getTown', input: { townId: 'town-6' } },
          { path: 'gastown.sendMessage', input: { townId: 'town-6', message: 'x' } },
        ])
      )
    ).resolves.toBe('cap-1');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).adminCapability.actions).toEqual([
      'trpc:gastown.getTown',
    ]);
  });

  it('requests nothing when every action is unlisted', async () => {
    await expect(
      browserCapabilityHeader(
        params([{ path: 'gastown.sendMessage', input: { townId: 'town-7', message: 'x' } }])
      )
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('re-mints instead of returning an expired cached capability', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    try {
      fetchMock
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              capability: 'cached',
              capabilityExpiresAt: new Date(Date.now() + 300_000).toISOString(),
            }),
            { status: 200 }
          )
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              capability: 'fresh',
              capabilityExpiresAt: new Date(Date.now() + 300_000).toISOString(),
            }),
            { status: 200 }
          )
        );
      const request = params([{ path: 'gastown.getTown', input: { townId: 'town-9' } }]);
      await expect(browserCapabilityHeader(request)).resolves.toBe('cached');

      // Stored expiry is real expiry minus the 30s safety pad, so advancing
      // past that pad must re-mint; a missing expiry check returns "cached".
      jest.setSystemTime(Date.now() + 271_000);
      await expect(browserCapabilityHeader(request)).resolves.toBe('fresh');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('widens when an in-flight result does not cover a concurrent caller', async () => {
    let resolveFirst!: (response: Response) => void;
    const firstResponse = new Promise<Response>(resolve => {
      resolveFirst = resolve;
    });
    fetchMock
      .mockImplementationOnce(() => firstResponse)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            capability: 'cap-2',
            capabilityExpiresAt: new Date(Date.now() + 300_000).toISOString(),
          }),
          { status: 200 }
        )
      );

    const narrow = browserCapabilityHeader(
      params([{ path: 'gastown.getTown', input: { townId: 'town-8' } }])
    );
    const wide = browserCapabilityHeader(
      params([
        { path: 'gastown.getTown', input: { townId: 'town-8' } },
        { path: 'gastown.getRig', input: { townId: 'town-8', rigId: 'rig-1' } },
      ])
    );
    resolveFirst(
      new Response(
        JSON.stringify({
          capability: 'cap-1',
          capabilityExpiresAt: new Date(Date.now() + 300_000).toISOString(),
        }),
        { status: 200 }
      )
    );

    await expect(narrow).resolves.toBe('cap-1');
    await expect(wide).resolves.toBe('cap-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string).adminCapability.actions).toEqual([
      'trpc:gastown.getRig',
      'trpc:gastown.getTown',
    ]);
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

  it('reuses a target capability and only widens it for new actions', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            capability: 'cap-1',
            capabilityExpiresAt: new Date(Date.now() + 300_000).toISOString(),
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            capability: 'cap-2',
            capabilityExpiresAt: new Date(Date.now() + 300_000).toISOString(),
          }),
          { status: 200 }
        )
      );

    await expect(
      browserCapabilityHeader(params([{ path: 'gastown.getTown', input: { townId: 'town-4' } }]))
    ).resolves.toBe('cap-1');
    await expect(
      browserCapabilityHeader(
        params([
          { path: 'gastown.getTown', input: { townId: 'town-4' } },
          { path: 'gastown.getRig', input: { townId: 'town-4', rigId: 'rig-1' } },
        ])
      )
    ).resolves.toBe('cap-2');
    await expect(
      browserCapabilityHeader(params([{ path: 'gastown.getTown', input: { townId: 'town-4' } }]))
    ).resolves.toBe('cap-2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string).adminCapability.actions).toEqual([
      'trpc:gastown.getRig',
      'trpc:gastown.getTown',
    ]);
  });

  it('swallows network failures and does not break the main request', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    const request = params([{ path: 'gastown.getTown', input: { townId: 'town-5' } }]);
    await expect(browserCapabilityHeader(request)).resolves.toBeNull();
    await expect(browserCapabilityHeader(request)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('negative-caches issuance failures so polling does not retry each time', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 403 }));
    const request = params([{ path: 'gastown.getTown', input: { townId: 'town-3' } }]);
    await expect(browserCapabilityHeader(request)).resolves.toBeNull();
    await expect(browserCapabilityHeader(request)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
