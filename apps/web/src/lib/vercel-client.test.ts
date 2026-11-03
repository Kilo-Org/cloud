import {
  discoverVercelProjects,
  discoverVercelTeams,
  validateVercelSelection,
  VercelApiError,
} from './vercel-client';

const TOKEN = 'vercel-test-token-do-not-expose';
const PROVIDER_DETAIL = 'private-provider-response-detail';
const TEAM = { id: 'team_one', slug: 'first-team', name: 'First Team' };
const PROJECT = { id: 'prj_one', name: 'first-project', accountId: TEAM.id };

let fetchMock: jest.SpiedFunction<typeof fetch>;

beforeEach(() => {
  fetchMock = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected request'));
});

afterEach(() => {
  jest.restoreAllMocks();
});

function teamsPage(teams: unknown[], next: number | null = null) {
  return { teams, pagination: { count: teams.length, next, prev: null } };
}

function projectsPage(projects: unknown[], next: number | string | null = null) {
  return {
    projects,
    pagination: {
      count: projects.length,
      next,
      ...(typeof next === 'number' ? { prev: null } : {}),
    },
  };
}

async function expectSafeError(result: Promise<unknown>, code: VercelApiError['code']) {
  const error: unknown = await result.catch((error: unknown) => error);
  expect(error).toBeInstanceOf(VercelApiError);
  if (!(error instanceof VercelApiError)) throw new Error('Expected a VercelApiError');
  expect(error.code).toBe(code);
  expect(error.message).toBe(new VercelApiError(code).message);
  expect(error).not.toHaveProperty('cause');
  expect(Object.keys(error).sort()).toEqual(['code', 'name']);
  const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
  expect(serialized).not.toContain(TOKEN);
  expect(serialized).not.toContain(PROVIDER_DETAIL);
}

describe('discoverVercelTeams', () => {
  it('returns only safe metadata, uses the slug for an unnamed team, and protects the request', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        ...teamsPage([
          { ...TEAM, token: TOKEN, billing: { secret: PROVIDER_DETAIL } },
          { id: 'team_two', slug: 'second-team', name: null },
        ]),
        token: TOKEN,
        provider: PROVIDER_DETAIL,
      })
    );

    const result = await discoverVercelTeams(TOKEN);

    expect(result).toEqual([TEAM, { id: 'team_two', slug: 'second-team', name: 'second-team' }]);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain(PROVIDER_DETAIL);
    expect(fetchMock).toHaveBeenCalledWith('https://api.vercel.com/v2/teams?limit=100', {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${TOKEN}` },
      cache: 'no-store',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
  });

  it('follows timestamp pagination, including zero, without resetting the operation deadline', async () => {
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    const secondTeam = { id: 'team_two', slug: 'second-team', name: 'Second Team' };
    fetchMock
      .mockResolvedValueOnce(Response.json(teamsPage([TEAM], 0)))
      .mockResolvedValueOnce(Response.json(teamsPage([secondTeam])));

    await expect(discoverVercelTeams(TOKEN)).resolves.toEqual([TEAM, secondTeam]);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.vercel.com/v2/teams?limit=100&until=0',
      expect.anything()
    );
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(fetchMock.mock.calls[1]?.[1]?.signal);
  });

  it('returns an empty list without falling back to a personal account', async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json(teamsPage([])))
      .mockResolvedValueOnce(Response.json(projectsPage([])));

    await expect(discoverVercelTeams(TOKEN)).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('finishes pagination before excluding teams the token has no readable access to', async () => {
    fetchMock
      .mockResolvedValueOnce(
        Response.json(teamsPage([{ ...TEAM, limited: true, limitedBy: ['scope'] }], 100))
      )
      .mockResolvedValueOnce(
        Response.json(teamsPage([{ id: 'team_two', slug: 'second-team', name: null }]))
      );

    await expect(discoverVercelTeams(TOKEN)).resolves.toEqual([
      { id: 'team_two', slug: 'second-team', name: 'second-team' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns no readable teams for a token with only limited team metadata', async () => {
    fetchMock
      .mockResolvedValueOnce(
        Response.json(teamsPage([{ ...TEAM, limited: true, limitedBy: ['scope'] }]))
      )
      .mockResolvedValueOnce(Response.json(projectsPage([])));

    await expect(discoverVercelTeams(TOKEN)).resolves.toEqual([]);
  });

  it('infers the owning team from a project-scoped token when team access is denied', async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ error: TOKEN }, { status: 403 }))
      .mockResolvedValueOnce(Response.json([{ ...PROJECT, slug: 'project-slug' }]));

    await expect(discoverVercelTeams(TOKEN)).resolves.toEqual([
      { id: TEAM.id, slug: TEAM.id, name: 'Project-scoped token', scope: 'project' },
    ]);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.vercel.com/v10/projects?limit=100',
      expect.objectContaining({ cache: 'no-store', redirect: 'error' })
    );
  });

  it.each([
    ['a null response', null],
    ['an unpaginated array', [TEAM]],
    ['a missing team list', { pagination: { count: 0, next: null, prev: null } }],
    ['a missing ID', teamsPage([{ slug: TEAM.slug, name: TEAM.name }])],
    ['an empty ID', teamsPage([{ ...TEAM, id: '' }])],
    ['a malformed name', teamsPage([{ ...TEAM, name: { secret: TOKEN } }])],
    ['a missing name', teamsPage([{ id: TEAM.id, slug: TEAM.slug }])],
    ['a malformed slug', teamsPage([{ ...TEAM, slug: null }])],
    ['a malformed limited flag', teamsPage([{ ...TEAM, limited: 'true' }])],
    ['missing pagination', { teams: [TEAM] }],
    ['a missing next cursor', { teams: [TEAM], pagination: { count: 1, prev: null } }],
    ['a missing previous cursor', { teams: [TEAM], pagination: { count: 1, next: null } }],
    ['a string cursor', { teams: [TEAM], pagination: { count: 1, next: TOKEN, prev: null } }],
    ['a negative cursor', teamsPage([TEAM], -1)],
    ['a fractional cursor', teamsPage([TEAM], 0.5)],
    [
      'a malformed previous cursor',
      { teams: [TEAM], pagination: { count: 1, next: null, prev: TOKEN } },
    ],
    ['a string count', { teams: [TEAM], pagination: { count: '1', next: null, prev: null } }],
    ['a negative count', { teams: [TEAM], pagination: { count: -1, next: null, prev: null } }],
    ['an inconsistent count', { teams: [TEAM], pagination: { count: 2, next: null, prev: null } }],
  ])('rejects %s without exposing provider data', async (_name, body) => {
    fetchMock.mockResolvedValueOnce(Response.json(body));

    await expectSafeError(discoverVercelTeams(TOKEN), 'BAD_GATEWAY');
  });

  it('does not return a partial list when a later page fails', async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json(teamsPage([TEAM], 100)))
      .mockResolvedValueOnce(Response.json({ error: TOKEN }, { status: 429 }));

    await expectSafeError(discoverVercelTeams(TOKEN), 'TOO_MANY_REQUESTS');
  });

  it('rejects cyclic pagination instead of returning a partial or repeated list', async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json(teamsPage([TEAM], 100)))
      .mockResolvedValueOnce(Response.json(teamsPage([TEAM], 50)))
      .mockResolvedValueOnce(Response.json(teamsPage([TEAM], 100)));

    await expectSafeError(discoverVercelTeams(TOKEN), 'BAD_GATEWAY');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('bounds page count even when every page is empty', async () => {
    let cursor = 100;
    fetchMock.mockImplementation(async () => Response.json(teamsPage([], cursor--)));

    await expectSafeError(discoverVercelTeams(TOKEN), 'BAD_REQUEST');
    expect(fetchMock).toHaveBeenCalledTimes(20);
  });

  it('rejects a list with undiscovered results beyond the result limit', async () => {
    let page = 0;
    fetchMock.mockImplementation(async () => {
      page++;
      return Response.json(
        teamsPage(
          Array.from({ length: 100 }, (_, index) => ({ ...TEAM, id: `team_${page}_${index}` })),
          100 - page
        )
      );
    });

    await expectSafeError(discoverVercelTeams(TOKEN), 'BAD_REQUEST');
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it('accepts exactly the result limit when the final page proves the list is complete', async () => {
    let page = 0;
    fetchMock.mockImplementation(async () => {
      page++;
      return Response.json(
        teamsPage(
          Array.from({ length: 100 }, (_, index) => ({ ...TEAM, id: `team_${page}_${index}` })),
          page === 10 ? null : 100 - page
        )
      );
    });

    await expect(discoverVercelTeams(TOKEN)).resolves.toHaveLength(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it('rejects an oversized final page instead of treating it as a complete supported list', async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json(
        teamsPage(Array.from({ length: 1_001 }, (_, index) => ({ ...TEAM, id: `team_${index}` })))
      )
    );

    await expectSafeError(discoverVercelTeams(TOKEN), 'BAD_REQUEST');
  });
});

describe('discoverVercelProjects', () => {
  it('checks team access and normalizes accountId and name using only safe fields', async () => {
    fetchMock.mockResolvedValueOnce(Response.json(TEAM)).mockResolvedValueOnce(
      Response.json(
        projectsPage([
          {
            ...PROJECT,
            slug: 'not-the-project-slug',
            token: TOKEN,
            env: [{ value: PROVIDER_DETAIL }],
            latestDeployments: [{ secret: TOKEN }],
          },
        ])
      )
    );

    const result = await discoverVercelProjects(TOKEN, TEAM.id);

    expect(result).toEqual([
      { id: PROJECT.id, name: PROJECT.name, slug: PROJECT.name, teamId: TEAM.id },
    ]);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain(PROVIDER_DETAIL);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `https://api.vercel.com/v2/teams/${TEAM.id}`,
      expect.anything()
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `https://api.vercel.com/v10/projects?teamId=${TEAM.id}&limit=100`,
      expect.objectContaining({ cache: 'no-store', redirect: 'error' })
    );
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(fetchMock.mock.calls[1]?.[1]?.signal);
  });

  it.each([1700000000000, 'JBSWY3DPEHPK3PXP'])(
    'follows the project cursor %s with from and teamId',
    async cursor => {
      fetchMock
        .mockResolvedValueOnce(Response.json(TEAM))
        .mockResolvedValueOnce(Response.json(projectsPage([PROJECT], cursor)))
        .mockResolvedValueOnce(
          Response.json(projectsPage([{ ...PROJECT, id: 'prj_two', name: 'second-project' }]))
        );

      await expect(discoverVercelProjects(TOKEN, TEAM.id)).resolves.toEqual([
        { id: PROJECT.id, name: PROJECT.name, slug: PROJECT.name, teamId: TEAM.id },
        { id: 'prj_two', name: 'second-project', slug: 'second-project', teamId: TEAM.id },
      ]);
      expect(fetchMock).toHaveBeenNthCalledWith(
        3,
        `https://api.vercel.com/v10/projects?teamId=${TEAM.id}&limit=100&from=${cursor}`,
        expect.anything()
      );
    }
  );

  it('continues empty pages and treats continuation cursors as a single query value', async () => {
    const cursor = 'opaque/value+with=padding&teamId=team_other';
    fetchMock
      .mockResolvedValueOnce(Response.json(TEAM))
      .mockResolvedValueOnce(Response.json(projectsPage([], cursor)))
      .mockResolvedValueOnce(Response.json(projectsPage([PROJECT])));

    await expect(discoverVercelProjects(TOKEN, TEAM.id)).resolves.toHaveLength(1);
    const nextUrl = new URL(String(fetchMock.mock.calls[2]?.[0]));
    expect(nextUrl.origin).toBe('https://api.vercel.com');
    expect(nextUrl.searchParams.getAll('teamId')).toEqual([TEAM.id]);
    expect(nextUrl.searchParams.get('from')).toBe(cursor);
  });

  it('returns an empty project list for a readable team', async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json(TEAM))
      .mockResolvedValueOnce(Response.json(projectsPage([])));

    await expect(discoverVercelProjects(TOKEN, TEAM.id)).resolves.toEqual([]);
  });

  it('discovers projects with a project-only token without team scope parameters', async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ error: TOKEN }, { status: 403 }))
      .mockResolvedValueOnce(Response.json([{ ...PROJECT, slug: 'project-slug' }]));

    await expect(discoverVercelProjects(TOKEN, TEAM.id)).resolves.toEqual([
      { id: PROJECT.id, name: PROJECT.name, slug: PROJECT.name, teamId: TEAM.id },
    ]);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `https://api.vercel.com/v10/projects?limit=100`,
      expect.objectContaining({ cache: 'no-store', redirect: 'error' })
    );
  });

  it.each([
    ['a null response', null],
    ['a malformed project list', { ...projectsPage([]), projects: {} }],
    ['a missing account ID', projectsPage([{ id: PROJECT.id, name: PROJECT.name }])],
    ['an empty project ID', projectsPage([{ ...PROJECT, id: '' }])],
    ['an empty project name', projectsPage([{ ...PROJECT, name: '' }])],
    ['a malformed project name', projectsPage([{ ...PROJECT, name: { secret: TOKEN } }])],
    ['missing pagination', { projects: [PROJECT] }],
    ['a missing next cursor', { projects: [PROJECT], pagination: { count: 1 } }],
    ['a missing previous timestamp', { projects: [PROJECT], pagination: { count: 1, next: 100 } }],
    ['an empty continuation cursor', projectsPage([PROJECT], '')],
    [
      'a malformed continuation cursor',
      { projects: [PROJECT], pagination: { count: 1, next: { secret: TOKEN } } },
    ],
    [
      'a malformed previous cursor',
      { projects: [PROJECT], pagination: { count: 1, next: null, prev: TOKEN } },
    ],
    ['an inconsistent count', { projects: [PROJECT], pagination: { count: 2, next: null } }],
  ])('rejects %s instead of returning an incomplete selection', async (_name, body) => {
    fetchMock.mockResolvedValueOnce(Response.json(TEAM)).mockResolvedValueOnce(Response.json(body));

    await expectSafeError(discoverVercelProjects(TOKEN, TEAM.id), 'BAD_GATEWAY');
  });

  it.each(['team_other', 'user_personal'])(
    'rejects a project owned by %s rather than filtering it out',
    async accountId => {
      fetchMock
        .mockResolvedValueOnce(Response.json(TEAM))
        .mockResolvedValueOnce(
          Response.json(projectsPage([PROJECT, { ...PROJECT, id: 'prj_other', accountId }]))
        );

      await expectSafeError(discoverVercelProjects(TOKEN, TEAM.id), 'FORBIDDEN');
    }
  );

  it('rejects repeated project continuation cursors', async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json(TEAM))
      .mockResolvedValueOnce(Response.json(projectsPage([PROJECT], 'JBSWY3DPEHPK3PXP')))
      .mockResolvedValueOnce(Response.json(projectsPage([PROJECT], 'JBSWY3DPEHPK3PXP')));

    await expectSafeError(discoverVercelProjects(TOKEN, TEAM.id), 'BAD_GATEWAY');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('Vercel request failures', () => {
  it.each([
    [401, 'UNAUTHORIZED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [410, 'NOT_FOUND'],
    [429, 'TOO_MANY_REQUESTS'],
    [408, 'SERVICE_UNAVAILABLE'],
    [500, 'SERVICE_UNAVAILABLE'],
    [502, 'SERVICE_UNAVAILABLE'],
    [503, 'SERVICE_UNAVAILABLE'],
    [504, 'SERVICE_UNAVAILABLE'],
    [400, 'BAD_GATEWAY'],
    [422, 'BAD_GATEWAY'],
    [302, 'BAD_GATEWAY'],
  ] as const)(
    'maps HTTP %s to %s without reading or retaining the provider error',
    async (status, code) => {
      const response = Response.json(
        { error: { message: `${TOKEN} ${PROVIDER_DETAIL}`, cause: { token: TOKEN } } },
        { status, statusText: PROVIDER_DETAIL }
      );
      const readBody = jest.spyOn(response, 'json');
      fetchMock.mockResolvedValueOnce(response);
      if (status === 403) {
        fetchMock.mockResolvedValueOnce(
          Response.json({ error: `${TOKEN} ${PROVIDER_DETAIL}` }, { status: 403 })
        );
      }

      await expectSafeError(discoverVercelTeams(TOKEN), code);
      expect(readBody).not.toHaveBeenCalled();
    }
  );

  it('sanitizes network errors and their causes', async () => {
    fetchMock.mockRejectedValueOnce(
      new Error(`${TOKEN} ${PROVIDER_DETAIL}`, { cause: { authorization: TOKEN } })
    );

    await expectSafeError(discoverVercelTeams(TOKEN), 'SERVICE_UNAVAILABLE');
  });

  it('sanitizes JSON syntax errors containing provider body text', async () => {
    fetchMock.mockResolvedValueOnce(new Response(`${TOKEN} ${PROVIDER_DETAIL}`));

    await expectSafeError(discoverVercelTeams(TOKEN), 'BAD_GATEWAY');
  });

  it('sanitizes rejected body reads and their causes', async () => {
    const response = Response.json(teamsPage([TEAM]));
    jest
      .spyOn(response, 'json')
      .mockRejectedValueOnce(new Error(`${TOKEN} ${PROVIDER_DETAIL}`, { cause: { token: TOKEN } }));
    fetchMock.mockResolvedValueOnce(response);

    await expectSafeError(discoverVercelTeams(TOKEN), 'BAD_GATEWAY');
  });

  it('sanitizes fetch timeouts without waiting for a real timeout', async () => {
    const controller = new AbortController();
    jest.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(controller.signal);
    fetchMock.mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new Error(`${TOKEN} ${PROVIDER_DETAIL}`)),
            { once: true }
          );
        })
    );

    const result = discoverVercelTeams(TOKEN);
    controller.abort();

    await expectSafeError(result, 'SERVICE_UNAVAILABLE');
  });

  it('keeps the timeout active while reading the response body', async () => {
    const controller = new AbortController();
    jest.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(controller.signal);
    const response = Response.json(teamsPage([TEAM]));
    jest.spyOn(response, 'json').mockImplementationOnce(async () => {
      controller.abort();
      throw new Error(`${TOKEN} ${PROVIDER_DETAIL}`);
    });
    fetchMock.mockResolvedValueOnce(response);

    await expectSafeError(discoverVercelTeams(TOKEN), 'SERVICE_UNAVAILABLE');
  });

  it('rejects an unexpectedly redirected response', async () => {
    const response = Response.json(teamsPage([TEAM]));
    Object.defineProperty(response, 'redirected', { value: true });
    fetchMock.mockResolvedValueOnce(response);

    await expectSafeError(discoverVercelTeams(TOKEN), 'BAD_GATEWAY');
  });
});

describe('validateVercelSelection', () => {
  it('waits for team access before inspecting the exact team-scoped project and returns no provider data', async () => {
    const teamResponse = Promise.withResolvers<Response>();
    const timeout = jest.spyOn(AbortSignal, 'timeout');
    fetchMock
      .mockReturnValueOnce(teamResponse.promise)
      .mockResolvedValueOnce(
        Response.json({ ...PROJECT, token: TOKEN, env: [{ value: PROVIDER_DETAIL }] })
      );

    const result = validateVercelSelection(TOKEN, TEAM.id, PROJECT.id);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `https://api.vercel.com/v2/teams/${TEAM.id}`,
      expect.anything()
    );
    teamResponse.resolve(Response.json(TEAM));

    await expect(result).resolves.toEqual({
      teamSlug: TEAM.slug,
      projectSlug: PROJECT.name,
      tokenScope: 'team',
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `https://api.vercel.com/v9/projects/${PROJECT.id}?teamId=${TEAM.id}`,
      {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${TOKEN}` },
        cache: 'no-store',
        redirect: 'error',
        signal: expect.any(AbortSignal),
      }
    );
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(fetchMock.mock.calls[1]?.[1]?.signal);
  });

  it('validates a project-scoped token with the inferred project and no team request', async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ error: TOKEN }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ ...PROJECT, slug: 'project-slug' }));

    await expect(validateVercelSelection(TOKEN, TEAM.id, PROJECT.id)).resolves.toEqual({
      teamSlug: null,
      projectSlug: PROJECT.name,
      tokenScope: 'project',
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `https://api.vercel.com/v9/projects/${PROJECT.id}`,
      expect.objectContaining({
        headers: { Accept: 'application/json', Authorization: `Bearer ${TOKEN}` },
      })
    );
  });

  it.each([
    [401, 'UNAUTHORIZED'],
    [404, 'NOT_FOUND'],
  ] as const)(
    'rejects unavailable team access (%s) without trying the project',
    async (status, code) => {
      fetchMock.mockResolvedValueOnce(Response.json({ error: TOKEN }, { status }));

      await expectSafeError(validateVercelSelection(TOKEN, TEAM.id, PROJECT.id), code);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  it('rejects a personally owned project even when its account ID matches the submitted team ID', async () => {
    const accountId = 'user_personal';
    fetchMock
      .mockResolvedValueOnce(Response.json({ error: TOKEN }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ ...PROJECT, accountId }));

    await expectSafeError(validateVercelSelection(TOKEN, accountId, PROJECT.id), 'FORBIDDEN');
  });

  it('maps denied project-scope validation to the provider error', async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ error: TOKEN }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ error: TOKEN }, { status: 403 }));

    await expectSafeError(validateVercelSelection(TOKEN, TEAM.id, PROJECT.id), 'FORBIDDEN');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a different team', { ...TEAM, id: 'team_other' }, 'FORBIDDEN'],
    ['a personal account', { ...TEAM, id: 'user_personal' }, 'FORBIDDEN'],
    ['limited team access', { ...TEAM, limited: true, limitedBy: ['scope'] }, 'FORBIDDEN'],
    ['a malformed team', { ...TEAM, id: { token: TOKEN } }, 'BAD_GATEWAY'],
  ] as const)('rejects %s before inspecting the project', async (_name, body, code) => {
    fetchMock.mockResolvedValueOnce(Response.json(body));

    await expectSafeError(validateVercelSelection(TOKEN, TEAM.id, PROJECT.id), code);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('requires the submitted team ID to match rather than accepting a team slug', async () => {
    fetchMock.mockResolvedValueOnce(Response.json(TEAM));

    await expectSafeError(validateVercelSelection(TOKEN, TEAM.slug, PROJECT.id), 'FORBIDDEN');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a different project', { ...PROJECT, id: 'prj_other' }, 'FORBIDDEN'],
    ['a different owning team', { ...PROJECT, accountId: 'team_other' }, 'FORBIDDEN'],
    ['a personally owned project', { ...PROJECT, accountId: 'user_personal' }, 'FORBIDDEN'],
    ['a missing account ID', { id: PROJECT.id, name: PROJECT.name }, 'BAD_GATEWAY'],
    ['a malformed project', { ...PROJECT, id: { token: TOKEN } }, 'BAD_GATEWAY'],
  ] as const)('rejects %s during final validation', async (_name, body, code) => {
    fetchMock.mockResolvedValueOnce(Response.json(TEAM)).mockResolvedValueOnce(Response.json(body));

    await expectSafeError(validateVercelSelection(TOKEN, TEAM.id, PROJECT.id), code);
  });

  it('requires the submitted project ID to match rather than accepting the project name', async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json(TEAM))
      .mockResolvedValueOnce(Response.json(PROJECT));

    await expectSafeError(validateVercelSelection(TOKEN, TEAM.id, PROJECT.name), 'FORBIDDEN');
  });

  it('uses a changed token and rechecks team access after successful discovery', async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json(teamsPage([TEAM])))
      .mockResolvedValueOnce(Response.json({ error: TOKEN }, { status: 401 }));
    await discoverVercelTeams(TOKEN);

    await expectSafeError(
      validateVercelSelection('changed-token', TEAM.id, PROJECT.id),
      'UNAUTHORIZED'
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(
      `https://api.vercel.com/v2/teams/${TEAM.id}`,
      expect.objectContaining({
        headers: { Accept: 'application/json', Authorization: 'Bearer changed-token' },
      })
    );
  });

  it.each([
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
  ] as const)(
    'rechecks a project whose access changed after discovery (%s)',
    async (status, code) => {
      fetchMock
        .mockResolvedValueOnce(Response.json(TEAM))
        .mockResolvedValueOnce(Response.json(projectsPage([PROJECT])))
        .mockResolvedValueOnce(Response.json(TEAM))
        .mockResolvedValueOnce(Response.json({ error: TOKEN }, { status }));
      await discoverVercelProjects(TOKEN, TEAM.id);

      await expectSafeError(validateVercelSelection(TOKEN, TEAM.id, PROJECT.id), code);
      expect(fetchMock).toHaveBeenCalledTimes(4);
    }
  );
});
