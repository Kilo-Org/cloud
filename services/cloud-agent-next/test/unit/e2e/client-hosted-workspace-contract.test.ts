import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createHostedWorkspace,
  deleteWorktree,
  getHostedWorkspaceStatus,
  type DriverConfig,
  type HostedWorkspaceStatus,
} from '../../../test/e2e/client.js';

const WORKSPACE_ID = 'worktree_11111111-1111-4111-8111-111111111111';
const PROFILE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function okEnvelope(result: unknown): Response {
  return new Response(JSON.stringify({ result: { data: result } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const baseConfig: DriverConfig = {
  workerUrl: 'http://worker.test',
  fakeLlmUrl: 'http://fake.test',
  user: { id: 'usr_test', email: 'test@example.com' },
  bearerToken: 'test-bearer',
  gitUrl: 'https://github.com/octocat/Hello-World.git',
  model: 'kilo/fake-deterministic',
};

function requestUrl(fetchMock: ReturnType<typeof vi.fn>, index: number): URL {
  const url = fetchMock.mock.calls[index]?.[0];
  if (!(url instanceof URL)) throw new Error(`Expected an URL request at call ${index}`);
  return url;
}

function requestInit(fetchMock: ReturnType<typeof vi.fn>, index: number): RequestInit {
  const init = fetchMock.mock.calls[index]?.[1] as RequestInit | undefined;
  if (!init) throw new Error(`Expected request options at call ${index}`);
  return init;
}

describe('hosted workspace status client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the passive status projection through a GET', async () => {
    const status = { workspaceId: WORKSPACE_ID } as HostedWorkspaceStatus;
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(status));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      getHostedWorkspaceStatus(baseConfig, { workspaceId: WORKSPACE_ID })
    ).resolves.toEqual(status);

    const url = requestUrl(fetchMock, 0);
    expect(url.origin + url.pathname).toBe('http://worker.test/trpc/getHostedWorkspaceStatus');
    expect(JSON.parse(url.searchParams.get('input') ?? '')).toEqual({
      workspaceId: WORKSPACE_ID,
    });
    expect(requestInit(fetchMock, 0).method).toBe('GET');
  });

  it('forwards an explicit organization scope without mutating it', async () => {
    const organizationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope({}));
    vi.stubGlobal('fetch', fetchMock);

    await getHostedWorkspaceStatus(baseConfig, {
      workspaceId: WORKSPACE_ID,
      kilocodeOrganizationId: organizationId,
    });

    expect(JSON.parse(requestUrl(fetchMock, 0).searchParams.get('input') ?? '')).toEqual({
      workspaceId: WORKSPACE_ID,
      kilocodeOrganizationId: organizationId,
    });
  });

  it('surfaces a rejection instead of inventing a status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'NOT_FOUND' } }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );

    await expect(
      getHostedWorkspaceStatus(baseConfig, { workspaceId: WORKSPACE_ID })
    ).rejects.toThrow(/NOT_FOUND/);
  });
});

describe('hosted workspace deletion client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts deleteWorktree with the internal secret and returns the deleted roots', async () => {
    const result = {
      success: true as const,
      deletedSessionIds: ['ses_12345678901234567890123456'],
    };
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(result));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      deleteWorktree(
        { ...baseConfig, internalApiSecret: 'internal-secret' },
        {
          worktreeId: WORKSPACE_ID,
        }
      )
    ).resolves.toEqual(result);

    const url = requestUrl(fetchMock, 0);
    expect(url.origin + url.pathname).toBe('http://worker.test/trpc/deleteWorktree');
    expect(requestInit(fetchMock, 0).method).toBe('POST');
    expect(requestInit(fetchMock, 0).headers).toMatchObject({
      'x-internal-api-key': 'internal-secret',
    });
    expect(JSON.stringify(requestInit(fetchMock, 0).body)).toContain(WORKSPACE_ID);
  });
});

describe('hosted workspace creation repository override', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function createResult(): unknown {
    return {
      workspaceId: WORKSPACE_ID,
      cloudAgentSessionId: 'workspace_11111111-1111-4111-8111-111111111111',
      kiloSessionId: 'ses_12345678901234567890123456',
      messageId: 'msg_0123456789abAAAAAAAAAAAAAA',
    };
  }

  function sentBody(fetchMock: ReturnType<typeof vi.fn>, index: number): Record<string, unknown> {
    const body = requestInit(fetchMock, index).body;
    if (typeof body !== 'string') throw new Error('Expected a JSON string body');
    return JSON.parse(body) as Record<string, unknown>;
  }

  it('defaults to the driver repository', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(createResult()));
    vi.stubGlobal('fetch', fetchMock);

    await createHostedWorkspace(baseConfig, {
      operationKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      profileId: PROFILE_ID,
      prompt: 'echo:root',
    });

    expect(sentBody(fetchMock, 0).repository).toEqual({
      type: 'git',
      url: baseConfig.gitUrl,
    });
  });

  it('prefers a GitHub repository from the driver config', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(createResult()));
    vi.stubGlobal('fetch', fetchMock);

    await createHostedWorkspace(
      { ...baseConfig, githubRepo: 'octocat/Hello-World' },
      {
        operationKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        profileId: PROFILE_ID,
        prompt: 'echo:root',
      }
    );

    expect(sentBody(fetchMock, 0).repository).toEqual({
      type: 'github',
      repo: 'octocat/Hello-World',
    });
  });

  it('uses an explicit second repository without changing the driver', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope(createResult()));
    vi.stubGlobal('fetch', fetchMock);

    await createHostedWorkspace(
      { ...baseConfig, githubRepo: 'octocat/Hello-World' },
      {
        operationKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        profileId: PROFILE_ID,
        prompt: 'echo:second',
        repository: { type: 'git', url: 'https://github.com/octocat/Spoon-Knife.git' },
      }
    );

    expect(sentBody(fetchMock, 0).repository).toEqual({
      type: 'git',
      url: 'https://github.com/octocat/Spoon-Knife.git',
    });
    expect(baseConfig.githubRepo).toBeUndefined();
  });
});
