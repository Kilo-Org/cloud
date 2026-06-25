jest.mock('@/lib/config.server', () => ({
  BITBUCKET_CLIENT_ID: 'bitbucket-client-id',
  BITBUCKET_CLIENT_SECRET: 'bitbucket-client-secret',
}));

import {
  buildBitbucketOAuthUrl,
  exchangeBitbucketOAuthCode,
  fetchBitbucketUser,
  fetchBitbucketWorkspaces,
} from './adapter';

function validTokenResponse(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    token_type: 'bearer',
    expires_in: 3600,
    scope: 'repository:write account pullrequest webhook',
    ...overrides,
  });
}

describe('Bitbucket OAuth adapter', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });
  it('builds the canonical authorization URL with only the required scopes', () => {
    const url = new URL(buildBitbucketOAuthUrl('signed-state'));

    expect(`${url.origin}${url.pathname}`).toBe('https://bitbucket.org/site/oauth2/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'bitbucket-client-id',
      response_type: 'code',
      scope: 'account repository:write pullrequest webhook',
      state: 'signed-state',
    });
    expect(url.toString()).not.toContain('bitbucket-client-secret');
  });

  it('exchanges an authorization code with Basic auth and a form body', async () => {
    const authorizationCode = 'authorization code+&=';
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValueOnce(validTokenResponse());

    await expect(exchangeBitbucketOAuthCode(authorizationCode)).resolves.toEqual({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      tokenType: 'bearer',
      expiresIn: 3600,
      scopes: ['account', 'email', 'pullrequest', 'repository', 'repository:write', 'webhook'],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://bitbucket.org/site/oauth2/access_token');
    expect(init).toEqual(
      expect.objectContaining({
        method: 'POST',
        redirect: 'manual',
        headers: {
          Accept: 'application/json',
          Authorization: `Basic ${Buffer.from(
            'bitbucket-client-id:bitbucket-client-secret'
          ).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      })
    );
    expect(new URLSearchParams(init?.body as string)).toEqual(
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: authorizationCode,
      })
    );
  });

  it.each([
    { access_token: '' },
    { access_token: '   ' },
    { access_token: ' access-token' },
    { access_token: 'access-token ' },
    { refresh_token: '' },
    { refresh_token: '   ' },
    { refresh_token: ' refresh-token' },
    { refresh_token: 'refresh-token ' },
  ])('rejects invalid rotating OAuth tokens', async invalidToken => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(validTokenResponse(invalidToken));

    await expect(exchangeBitbucketOAuthCode('authorization-code')).rejects.toThrow(
      'Bitbucket OAuth token exchange returned invalid credentials'
    );
  });

  it('rejects token responses that do not use bearer authentication', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(validTokenResponse({ token_type: 'mac' }));

    await expect(exchangeBitbucketOAuthCode('authorization-code')).rejects.toThrow(
      'Bitbucket OAuth token exchange returned invalid credentials'
    );
  });

  it.each([0, -1, 1.5, 86_401])('rejects invalid or unbounded token expiry', async expiresIn => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(validTokenResponse({ expires_in: expiresIn }));

    await expect(exchangeBitbucketOAuthCode('authorization-code')).rejects.toThrow(
      'Bitbucket OAuth token exchange returned invalid credentials'
    );
  });

  it('accepts the transitional plural scopes field alongside canonical scope', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      validTokenResponse({
        scopes: 'repository:write repository account pullrequest webhook',
      })
    );

    await expect(exchangeBitbucketOAuthCode('authorization-code')).resolves.toEqual(
      expect.objectContaining({
        scopes: ['account', 'email', 'pullrequest', 'repository', 'repository:write', 'webhook'],
      })
    );
  });

  it('accepts Atlassian legacy scope aliases returned by Bitbucket OAuth', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      validTokenResponse({
        scope: [
          'read:pullrequest:bitbucket-legacy',
          'pullrequest',
          'offline_access',
          'write:repository:bitbucket-legacy',
          'read:account:bitbucket-legacy',
          'admin:webhook:bitbucket-legacy',
          'read:email:bitbucket-legacy',
          'read:repository:bitbucket-legacy',
        ].join(' '),
      })
    );

    await expect(exchangeBitbucketOAuthCode('authorization-code')).resolves.toEqual(
      expect.objectContaining({
        scopes: ['account', 'email', 'pullrequest', 'repository', 'repository:write', 'webhook'],
      })
    );
  });

  it('rejects the retired plural scopes response field without canonical scope', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        validTokenResponse({ scope: undefined, scopes: 'account repository:write webhook' })
      );

    await expect(exchangeBitbucketOAuthCode('authorization-code')).rejects.toThrow(
      'Bitbucket OAuth token exchange returned invalid credentials'
    );
  });

  it.each([
    'account repository webhook',
    'repository:write repository webhook',
    'account repository:write webhook',
    'account repository:write',
  ])('rejects token responses missing a required OAuth scope', async scope => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(validTokenResponse({ scope }));

    await expect(exchangeBitbucketOAuthCode('authorization-code')).rejects.toThrow(
      'Bitbucket OAuth token exchange returned invalid credentials'
    );
  });

  it('ignores token response scopes beyond the required OAuth grant', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      validTokenResponse({
        scope: 'account repository repository:write pullrequest webhook snippet',
      })
    );

    await expect(exchangeBitbucketOAuthCode('authorization-code')).resolves.toEqual(
      expect.objectContaining({
        scopes: ['account', 'email', 'pullrequest', 'repository', 'repository:write', 'webhook'],
      })
    );
  });

  it('accepts the email permission implied by the required account scope', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      validTokenResponse({
        scope: 'repository:write repository account email pullrequest webhook',
      })
    );

    await expect(exchangeBitbucketOAuthCode('authorization-code')).resolves.toEqual(
      expect.objectContaining({
        scopes: ['account', 'email', 'pullrequest', 'repository', 'repository:write', 'webhook'],
      })
    );
  });

  it('normalizes duplicate and implied OAuth scopes', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      validTokenResponse({
        scope: ' repository:write  account repository:write pullrequest webhook webhook ',
      })
    );

    await expect(exchangeBitbucketOAuthCode('authorization-code')).resolves.toEqual(
      expect.objectContaining({
        scopes: ['account', 'email', 'pullrequest', 'repository', 'repository:write', 'webhook'],
      })
    );
  });

  it('does not expose malformed token response bodies', async () => {
    const providerBody = 'provider-access-token-is-not-json';
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(providerBody, {
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const exchange = exchangeBitbucketOAuthCode('authorization-code');
    await expect(exchange).rejects.toThrow(
      'Bitbucket OAuth token exchange returned invalid credentials'
    );
    await expect(exchange).rejects.not.toThrow(providerBody);
  });

  it('does not expose failed token response bodies', async () => {
    const providerBody = 'provider-error-containing-a-token';
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(providerBody, {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const exchange = exchangeBitbucketOAuthCode('authorization-code');
    await expect(exchange).rejects.toThrow('Bitbucket OAuth token exchange failed (400)');
    await expect(exchange).rejects.not.toThrow(providerBody);
  });

  it('fetches only the safe current-user identity fields', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      Response.json({
        uuid: '{user-uuid}',
        nickname: 'octobucket',
        display_name: 'Octo Bucket',
        email: 'must-not-leak@example.com',
        links: { self: { href: 'https://api.bitbucket.org/2.0/users/user-uuid' } },
      })
    );

    await expect(fetchBitbucketUser('access-token')).resolves.toEqual({
      uuid: '{user-uuid}',
      nickname: 'octobucket',
      displayName: 'Octo Bucket',
    });
    expect(fetchMock).toHaveBeenCalledWith('https://api.bitbucket.org/2.0/user', {
      redirect: 'manual',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer access-token',
      },
    });
  });

  it.each(['uuid', 'nickname', 'display_name'])(
    'rejects a current-user response with a blank %s',
    async field => {
      jest.spyOn(global, 'fetch').mockResolvedValueOnce(
        Response.json({
          uuid: '{user-uuid}',
          nickname: 'octobucket',
          display_name: 'Octo Bucket',
          [field]: '   ',
        })
      );

      await expect(fetchBitbucketUser('access-token')).rejects.toThrow(
        'Bitbucket current-user request returned an invalid identity'
      );
    }
  );

  it.each([
    ['uuid', ' {user-uuid}'],
    ['nickname', 'octobucket '],
    ['display_name', ' Octo Bucket'],
  ])('rejects a current-user response with whitespace-padded %s', async (field, value) => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      Response.json({
        uuid: '{user-uuid}',
        nickname: 'octobucket',
        display_name: 'Octo Bucket',
        [field]: value,
      })
    );

    await expect(fetchBitbucketUser('access-token')).rejects.toThrow(
      'Bitbucket current-user request returned an invalid identity'
    );
  });

  it('does not expose malformed current-user response bodies', async () => {
    const providerBody = 'provider-user-body-containing-a-token';
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(providerBody, {
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const request = fetchBitbucketUser('access-token');
    await expect(request).rejects.toThrow(
      'Bitbucket current-user request returned an invalid identity'
    );
    await expect(request).rejects.not.toThrow(providerBody);
  });

  it('does not expose failed current-user response bodies or access tokens', async () => {
    const accessToken = 'current-user-access-token';
    const providerBody = 'provider-current-user-error-body';
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(new Response(providerBody, { status: 401 }));

    const request = fetchBitbucketUser(accessToken);
    await expect(request).rejects.toThrow('Bitbucket current-user request failed (401)');
    await expect(request).rejects.not.toThrow(providerBody);
    await expect(request).rejects.not.toThrow(accessToken);
  });

  it('fetches safe workspace metadata with manual redirects', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      Response.json({
        values: [
          {
            administrator: true,
            workspace: {
              uuid: '{workspace-uuid}',
              slug: 'kilo-workspace',
              name: 'Kilo Workspace',
              links: { self: { href: 'https://api.bitbucket.org/2.0/workspaces/kilo-workspace' } },
            },
          },
        ],
      })
    );

    await expect(fetchBitbucketWorkspaces('access-token')).resolves.toEqual([
      {
        uuid: '{workspace-uuid}',
        slug: 'kilo-workspace',
        name: 'Kilo Workspace',
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith('https://api.bitbucket.org/2.0/user/workspaces', {
      redirect: 'manual',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer access-token',
      },
    });
  });

  it.each(['uuid', 'slug', 'name'])('rejects a workspace response with a blank %s', async field => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      Response.json({
        values: [
          {
            workspace: {
              uuid: '{workspace-uuid}',
              slug: 'kilo-workspace',
              name: 'Kilo Workspace',
              [field]: '   ',
            },
          },
        ],
      })
    );

    await expect(fetchBitbucketWorkspaces('access-token')).rejects.toThrow(
      'Bitbucket workspace request returned an invalid response'
    );
  });

  it.each([
    ['uuid', ' {workspace-uuid}'],
    ['slug', 'kilo-workspace '],
    ['name', ' Kilo Workspace'],
  ])('rejects a workspace response with whitespace-padded %s', async (field, value) => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      Response.json({
        values: [
          {
            workspace: {
              uuid: '{workspace-uuid}',
              slug: 'kilo-workspace',
              name: 'Kilo Workspace',
              [field]: value,
            },
          },
        ],
      })
    );

    await expect(fetchBitbucketWorkspaces('access-token')).rejects.toThrow(
      'Bitbucket workspace request returned an invalid response'
    );
  });

  it('does not expose malformed workspace response bodies', async () => {
    const providerBody = 'provider-workspace-body-containing-a-token';
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(providerBody, {
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const request = fetchBitbucketWorkspaces('access-token');
    await expect(request).rejects.toThrow(
      'Bitbucket workspace request returned an invalid response'
    );
    await expect(request).rejects.not.toThrow(providerBody);
  });

  it('does not expose failed workspace response bodies or access tokens', async () => {
    const accessToken = 'workspace-access-token';
    const providerBody = 'provider-workspace-error-body';
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(new Response(providerBody, { status: 403 }));

    const request = fetchBitbucketWorkspaces(accessToken);
    await expect(request).rejects.toThrow('Bitbucket workspace request failed (403)');
    await expect(request).rejects.not.toThrow(providerBody);
    await expect(request).rejects.not.toThrow(accessToken);
  });

  it('follows opaque workspace pagination links', async () => {
    const nextUrl = 'https://api.bitbucket.org/2.0/user/workspaces?cursor=opaque%3Dvalue';
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        Response.json({
          values: [
            {
              workspace: {
                uuid: '{workspace-1}',
                slug: 'workspace-1',
                name: 'Workspace One',
              },
            },
          ],
          next: nextUrl,
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          values: [
            {
              workspace: {
                uuid: '{workspace-2}',
                slug: 'workspace-2',
                name: 'Workspace Two',
              },
            },
          ],
        })
      );

    await expect(fetchBitbucketWorkspaces('access-token')).resolves.toEqual([
      { uuid: '{workspace-1}', slug: 'workspace-1', name: 'Workspace One' },
      { uuid: '{workspace-2}', slug: 'workspace-2', name: 'Workspace Two' },
    ]);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      nextUrl,
      expect.objectContaining({ redirect: 'manual' })
    );
  });

  it('rejects workspace API redirects without following them', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { Location: 'https://api.bitbucket.org/2.0/user/workspaces?cursor=next' },
      })
    );

    await expect(fetchBitbucketWorkspaces('access-token')).rejects.toThrow(
      'Bitbucket workspace request failed (302)'
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    'https://attacker.example/2.0/user/workspaces?cursor=next',
    'http://api.bitbucket.org/2.0/user/workspaces?cursor=next',
    'HTTPS://api.bitbucket.org/2.0/user/workspaces?cursor=next',
    'https://API.bitbucket.org/2.0/user/workspaces?cursor=next',
    'https://api.bitbucket.org./2.0/user/workspaces?cursor=next',
    'https://user:password@api.bitbucket.org/2.0/user/workspaces?cursor=next',
    'https://api.bitbucket.org:443/2.0/user/workspaces?cursor=next',
    'https://api.bitbucket.org:8443/2.0/user/workspaces?cursor=next',
    'https://api.bitbucket.org/2.0/user/workspaces#',
    'https://api.bitbucket.org/2.0/user/workspaces?cursor=next#',
    'https://api.bitbucket.org/2.0/user/workspaces?cursor=next#fragment',
    'https://api.bitbucket.org/2.0/user/workspaces/?cursor=next',
    'https://api.bitbucket.org/2.0/repositories?cursor=next',
    'https://api.bitbucket.org/2.0/user/segment/../workspaces?cursor=next',
    'https://api.bitbucket.org/2.0/user/%2e%2e/user/workspaces?cursor=next',
  ])('rejects unsafe workspace pagination URLs before fetching them', async next => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(Response.json({ values: [], next }));

    await expect(fetchBitbucketWorkspaces('access-token')).rejects.toThrow(
      'Bitbucket refused unsafe workspace pagination URL'
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects workspace pagination cycles before refetching a page', async () => {
    const firstUrl = 'https://api.bitbucket.org/2.0/user/workspaces';
    const secondUrl = `${firstUrl}?cursor=second`;
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(Response.json({ values: [], next: secondUrl }))
      .mockResolvedValueOnce(Response.json({ values: [], next: firstUrl }))
      .mockRejectedValueOnce(new Error('must not fetch a visited page'));

    await expect(fetchBitbucketWorkspaces('access-token')).rejects.toThrow(
      'Bitbucket workspace pagination cycle detected'
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects workspace pagination that exceeds the page cap', async () => {
    let page = 0;
    const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async () => {
      page += 1;
      if (page > 21) {
        throw new Error('must stop at the workspace page cap');
      }
      return Response.json({
        values: [],
        next: `https://api.bitbucket.org/2.0/user/workspaces?cursor=${page + 1}`,
      });
    });

    await expect(fetchBitbucketWorkspaces('access-token')).rejects.toThrow(
      'Bitbucket workspace pagination exceeded page limit'
    );
    expect(fetchMock).toHaveBeenCalledTimes(20);
  });

  it('rejects workspace pagination that exceeds the item cap', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      Response.json({
        values: Array.from({ length: 501 }, (_, index) => ({
          workspace: {
            uuid: `{workspace-${index}}`,
            slug: `workspace-${index}`,
            name: `Workspace ${index}`,
          },
        })),
      })
    );

    await expect(fetchBitbucketWorkspaces('access-token')).rejects.toThrow(
      'Bitbucket workspace pagination exceeded item limit'
    );
  });

  it('does not fetch another workspace page after reaching the item cap', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        Response.json({
          values: Array.from({ length: 500 }, (_, index) => ({
            workspace: {
              uuid: `{workspace-${index}}`,
              slug: `workspace-${index}`,
              name: `Workspace ${index}`,
            },
          })),
          next: 'https://api.bitbucket.org/2.0/user/workspaces?cursor=overflow',
        })
      )
      .mockRejectedValueOnce(new Error('must not fetch past the workspace item cap'));

    await expect(fetchBitbucketWorkspaces('access-token')).rejects.toThrow(
      'Bitbucket workspace pagination exceeded item limit'
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
