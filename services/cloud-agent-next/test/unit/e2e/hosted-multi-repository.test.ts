import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHostedWorkspace } from '../../e2e/client.js';
import {
  parseHostedMultiRepositoryFixture,
  verifyHostedRepositoryCatalog,
} from '../../e2e/hosted-multi-repository.js';

const fixtureInput = {
  target: 'staging',
  workerUrl: 'https://stage-worker.test',
  backendUrl: 'https://stage-backend.test',
  organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  integrationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  profileId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  primary: { fullName: 'test/primary', markerPath: 'marker.txt', marker: 'primary-marker' },
  additional: { id: 22, fullName: 'test/extra', markerPath: 'marker.txt', marker: 'extra-marker' },
};
const fixture = parseHostedMultiRepositoryFixture(fixtureInput);
const config = {
  workerUrl: fixture.workerUrl,
  user: { id: 'fixture-user' },
  bearerToken: 'test-bearer',
  skipBalanceCheck: false,
  kilocodeOrganizationId: fixture.organizationId,
  model: 'kilo/fake-deterministic',
  gitUrl: '',
  fakeLlmUrl: '',
};

function envelope(data: unknown): Response {
  return Response.json({ result: { data } });
}

describe('staged hosted multi-repository proof', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each([
    { target: 'production' },
    { workerUrl: 'https://cloud-agent-next.kilosessions.ai' },
    { workerUrl: 'https://cloud-agent-e2e-test.engineering-e11.workers.dev' },
    { workerUrl: 'https://cloud-agent-e2e.kiloapps.io' },
    { backendUrl: 'https://app.kilo.ai' },
    { additional: { ...fixtureInput.additional, fullName: 'other/PRIMARY' } },
    { primary: { ...fixtureInput.primary, markerPath: '../marker.txt' } },
  ])('rejects unsafe or unprovable fixture settings: %j', overrides => {
    expect(() => parseHostedMultiRepositoryFixture({ ...fixtureInput, ...overrides })).toThrow();
  });

  it.each([
    ['CLOUD_AGENT_E2E_WORKER_HOSTNAME', 'Fenced-E2E.example.test'],
    ['E2E_WORKER_HOSTNAME', 'fenced-e2e.example.test'],
    ['WORKER_URL', 'https://FENCED-E2E.example.test/'],
  ])('refuses the e2e Worker host configured through %s', (name, value) => {
    vi.stubEnv(name, value);
    expect(() =>
      parseHostedMultiRepositoryFixture({
        ...fixtureInput,
        workerUrl: 'https://fenced-e2e.example.test',
      })
    ).toThrow();
    expect(parseHostedMultiRepositoryFixture(fixtureInput).workerUrl).toBe(fixtureInput.workerUrl);
  });

  it('fails closed when the catalog does not advertise capability version 1', async () => {
    const fetchMock = vi.fn().mockResolvedValue(envelope({ repositories: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      verifyHostedRepositoryCatalog(config, fixture, new AbortController().signal)
    ).rejects.toThrow('hostedAdditionalRepositoriesVersion');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('probes the versioned and pinned repository catalog via GET and follows pagination', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        envelope({ hostedAdditionalRepositoriesVersion: 1, repositories: [], nextPage: 2 })
      )
      .mockResolvedValueOnce(
        envelope({
          hostedAdditionalRepositoriesVersion: 1,
          repositories: [
            { id: fixture.additional.id, fullName: fixture.additional.fullName, private: true },
          ],
        })
      );
    vi.stubGlobal('fetch', fetchMock);
    const signal = new AbortController().signal;
    await verifyHostedRepositoryCatalog(config, fixture, signal);
    const first: unknown = fetchMock.mock.calls[0]?.[0];
    const second: unknown = fetchMock.mock.calls[1]?.[0];
    if (!(first instanceof URL && second instanceof URL))
      throw new Error('Missing catalog requests');
    expect(first.pathname).toBe('/trpc/listHostedWorkspaceRepositories');
    const pinnedInput = {
      organizationId: fixture.organizationId,
      integrationId: fixture.integrationId,
      primaryRepo: fixture.primary.fullName,
    };
    expect(JSON.parse(first.searchParams.get('input') ?? '')).toEqual(pinnedInput);
    expect(JSON.parse(second.searchParams.get('input') ?? '')).toEqual({ ...pinnedInput, page: 2 });
    expect(fetchMock.mock.calls.map(call => call[1])).toEqual([
      expect.objectContaining({ method: 'GET', signal }),
      expect.objectContaining({ method: 'GET', signal }),
    ]);
  });

  it('fails before creation if the matching ID is returned for a different repository', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      envelope({
        hostedAdditionalRepositoriesVersion: 1,
        repositories: [{ id: fixture.additional.id, fullName: 'test/renamed', private: true }],
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      verifyHostedRepositoryCatalog(config, fixture, new AbortController().signal)
    ).rejects.toThrow('Additional repository ID resolved to the wrong name');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('posts promptless creation with the GitHub integration pin and top-level stable repository IDs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      envelope({
        workspaceId: 'worktree_11111111-1111-4111-8111-111111111111',
        cloudAgentSessionId: 'workspace_11111111-1111-4111-8111-111111111111',
        kiloSessionId: 'native-session-id',
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const operationKey = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const result = await createHostedWorkspace(config, {
      profileId: fixture.profileId,
      operationKey,
      repository: {
        type: 'github',
        repo: fixture.primary.fullName,
        githubIntegrationId: fixture.integrationId,
      },
      additionalRepositoryIds: [fixture.additional.id],
    });
    expect(result.messageId).toBeUndefined();
    const options: unknown = fetchMock.mock.calls[0]?.[1];
    if (
      typeof options !== 'object' ||
      options === null ||
      !('body' in options) ||
      typeof options.body !== 'string'
    ) {
      throw new Error('Missing create body');
    }
    expect(JSON.parse(options.body)).toEqual({
      operationKey,
      clientProvenance: 'agent-manager',
      profile: { id: fixture.profileId },
      repository: {
        type: 'github',
        repo: fixture.primary.fullName,
        githubIntegrationId: fixture.integrationId,
      },
      additionalRepositoryIds: [fixture.additional.id],
      agent: { mode: 'code', model: config.model },
      options: { kilocodeOrganizationId: fixture.organizationId },
    });
  });
});
