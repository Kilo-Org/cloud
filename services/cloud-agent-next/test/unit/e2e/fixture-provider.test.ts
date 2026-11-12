import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  FixtureDescriptor,
  FixtureProviderError,
  type ProviderCleanupRequest,
  type ProviderPrepareRequest,
  SCHEMA_VERSION,
  emptyCleanup,
} from '../../e2e/fixture-contract.js';
import {
  buildDescriptor,
  cleanupFixture,
  directiveTemplates,
  prepareFixture,
} from '../../e2e/fixture-provider.js';
import {
  FAKE_MODEL,
  ownerDescription,
  profileName,
  workspaceOwnership,
  type CloudObservation,
  type FixtureCloud,
  type HostedResources,
  type OwnedIds,
  type ResourceState,
  type RunIdentity,
} from '../../e2e/fixture-resources.js';
import type { LocalStack } from '../../e2e/fixture-stack.js';

const RUN_ID = 'run-1';
const SCOPE = 'kilo-e2e-run-1';
const USER_ID = 'user-1';
const TOKEN = 'token-1';
const CLEANUP_TOKEN = 'cleanup-token';

const STACK: LocalStack = {
  service: '/repo/services/cloud-agent-next',
  root: '/repo',
  web: 'http://localhost:43000',
  worker: 'http://localhost:43001',
  gateway: 'http://localhost:43002',
  fake: 'http://localhost:43003',
  postgres: 5432,
  database: 'postgres://postgres:postgres@localhost:5432/postgres',
};

type FakeOptions = {
  failCreateProfile?: boolean;
  failCreateWorkspace?: boolean;
  failInspect?: boolean;
  failListWaiters?: boolean;
  failDeleteWorkspace?: boolean;
  workspaceGoneAfterDelete?: boolean;
};

class FakeCloud implements FixtureCloud {
  readonly stack = STACK;
  readonly model = FAKE_MODEL;
  readonly calls: string[] = [];
  readonly identityValue: RunIdentity = {
    user: { id: USER_ID, email: 'fixture@example.com', api_token_pepper: null },
    token: TOKEN,
    apiKey: 'api-key-1',
  };
  profiles = new Map<string, { userId: string; name: string; description: string | null }>();
  worktrees = new Map<
    string,
    { userId: string; deletionStartedAt: string | null; deletionCompletedAt: string | null }
  >();
  sessions = new Map<string, { userId: string; profileId: string | null }>();
  workspaceSessions = new Map<string, string>();
  workspaceSeeds: (string | undefined)[] = [];
  gates: string[] = [];
  private profileSeq = 0;
  private workspaceSeq = 0;

  constructor(private readonly options: FakeOptions = {}) {}

  async identity(): Promise<RunIdentity> {
    return this.identityValue;
  }

  async createProfile(input: {
    runId: string;
    identity: RunIdentity;
    cleanupToken: string;
  }): Promise<string> {
    this.calls.push('createProfile');
    if (this.options.failCreateProfile) throw new Error('profile creation failed');
    const id = `profile-${++this.profileSeq}`;
    this.profiles.set(id, {
      userId: input.identity.user.id,
      name: profileName(input.runId),
      description: ownerDescription(input.cleanupToken),
    });
    return id;
  }

  async createWorkspace(input: {
    identity: RunIdentity;
    profileId: string;
    gitUrl: string;
    scope: string;
    seedPrompt?: string;
  }): Promise<HostedResources> {
    this.calls.push(`createWorkspace:${input.gitUrl}:${input.scope}`);
    this.workspaceSeeds.push(input.seedPrompt);
    if (this.options.failCreateWorkspace) throw new Error('workspace creation failed');
    const id = ++this.workspaceSeq;
    const workspaceId = `worktree_${id}`;
    const cloudAgentSessionId = `workspace_${id}`;
    this.worktrees.set(workspaceId, {
      userId: input.identity.user.id,
      deletionStartedAt: null,
      deletionCompletedAt: null,
    });
    this.sessions.set(cloudAgentSessionId, {
      userId: input.identity.user.id,
      profileId: input.profileId,
    });
    this.workspaceSessions.set(workspaceId, cloudAgentSessionId);
    return {
      workspaceId,
      cloudAgentSessionId,
      kiloSessionId: `ses_${id}`,
    };
  }

  async workspaceSummary(): Promise<null> {
    return null;
  }

  async inspect(ids: OwnedIds): Promise<ResourceState> {
    if (this.options.failInspect) throw new Error('database unavailable');
    return {
      profile: ids.profileId === undefined ? null : (this.profiles.get(ids.profileId) ?? null),
      worktree:
        ids.workspaceId === undefined ? null : (this.worktrees.get(ids.workspaceId) ?? null),
      session:
        ids.cloudSessionId === undefined ? null : (this.sessions.get(ids.cloudSessionId) ?? null),
    };
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    this.calls.push(`deleteWorkspace:${workspaceId}`);
    if (this.options.failDeleteWorkspace) throw new Error('workspace deletion failed');
    const row = this.worktrees.get(workspaceId);
    if (row) {
      this.worktrees.set(workspaceId, { ...row, deletionCompletedAt: '2026-11-02T00:00:00Z' });
    }
    // The real deletion removes root session rows and keeps the tombstone.
    const cloudSessionId = this.workspaceSessions.get(workspaceId);
    if (cloudSessionId !== undefined) {
      this.sessions.delete(cloudSessionId);
      this.workspaceSessions.delete(workspaceId);
    }
  }

  async deleteProfile(profileId: string): Promise<void> {
    this.calls.push(`deleteProfile:${profileId}`);
    this.profiles.delete(profileId);
  }

  async waitWorkspaceGone(workspaceId: string): Promise<boolean> {
    if (this.options.workspaceGoneAfterDelete === false) return false;
    return this.worktrees.get(workspaceId)?.deletionCompletedAt !== null;
  }

  async listWaiters(): Promise<string[]> {
    if (this.options.failListWaiters) throw new Error('fake LLM unavailable');
    return [...this.gates];
  }

  async releaseGate(tag: string): Promise<void> {
    this.calls.push(`releaseGate:${tag}`);
    this.gates = this.gates.filter(candidate => candidate !== tag);
  }

  async waitGate(tag: string): Promise<boolean> {
    return this.gates.includes(tag);
  }

  async observe(): Promise<CloudObservation> {
    return { chatCompletions: 0 };
  }

  async close(): Promise<void> {}
}

function prepareRequest(
  lane: 'local' | 'cloud',
  descriptorPath: string,
  scenarioId?: ProviderPrepareRequest['scenarioId']
): ProviderPrepareRequest {
  return {
    schemaVersion: SCHEMA_VERSION,
    operation: 'prepare',
    runId: RUN_ID,
    lane,
    ...(scenarioId === undefined ? {} : { scenarioId }),
    fakeLlmScope: SCOPE,
    descriptorPath,
    projectDir: '/tmp/project',
    state: { data: '/d', config: '/c', state: '/s', cache: '/k' },
  };
}

function cleanupRequest(descriptorPath: string, descriptorPresent = true): ProviderCleanupRequest {
  return {
    schemaVersion: SCHEMA_VERSION,
    operation: 'cleanup',
    runId: RUN_ID,
    descriptorPath,
    descriptorPresent,
  };
}

async function tempDescriptorPath(name = 'descriptor.json'): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'fixture-provider-'));
  return path.join(dir, name);
}

async function cloudDescriptor(cloud: FakeCloud): Promise<FixtureDescriptor> {
  const hosted = await cloud.createWorkspace({
    identity: cloud.identityValue,
    profileId: 'profile-1',
    gitUrl: 'https://github.com/octocat/Hello-World.git',
    scope: SCOPE,
  });
  cloud.profiles.set('profile-1', {
    userId: USER_ID,
    name: profileName(RUN_ID),
    description: ownerDescription(CLEANUP_TOKEN),
  });
  return buildDescriptor({
    request: prepareRequest('cloud', '/tmp/descriptor.json'),
    cloud,
    token: TOKEN,
    cleanupToken: CLEANUP_TOKEN,
    gitUrl: 'https://github.com/octocat/Hello-World.git',
    hosted,
    profileId: 'profile-1',
    now: new Date('2026-11-02T00:00:00.000Z'),
  });
}

describe('prepareFixture', () => {
  it('writes a mode-0600 local descriptor without hosted resources', async () => {
    const cloud = new FakeCloud();
    const descriptorPath = await tempDescriptorPath();
    const descriptor = await prepareFixture({
      request: prepareRequest('local', descriptorPath),
      cloud,
    });
    expect(descriptor.lane).toBe('local');
    expect(descriptor.resources).toEqual({});
    expect(descriptor.project.gitUrl).toBe('file:///tmp/project');
    expect(descriptor.project.model).toBe(FAKE_MODEL);
    expect(descriptor.origins.gateway).toBe('http://localhost:43002/api/v1');
    expect(descriptor.cleanup.ids).toEqual([{ kind: 'fake-llm-scope', id: SCOPE }]);
    expect((await stat(descriptorPath)).mode & 0o777).toBe(0o600);
    expect(cloud.calls).toEqual([]);
  });

  it('creates an owned profile and hosted workspace for the Cloud lane', async () => {
    const cloud = new FakeCloud();
    const descriptorPath = await tempDescriptorPath();
    const descriptor = await prepareFixture({
      request: prepareRequest('cloud', descriptorPath),
      cloud,
      gitUrl: 'https://github.com/octocat/Hello-World.git',
    });
    expect(descriptor.resources.profileId).toBe('profile-1');
    expect(descriptor.resources.workspaceId).toBe('worktree_1');
    expect(descriptor.resources.cloudSessionId).toBe('workspace_1');
    expect(descriptor.resources.nativeSessionId).toBe('ses_1');
    expect(cloud.calls).toContain(
      'createWorkspace:https://github.com/octocat/Hello-World.git:kilo-e2e-run-1'
    );
    const stored = FixtureDescriptor.parse(JSON.parse(await readFile(descriptorPath, 'utf8')));
    expect(stored.cleanup.ids.map(resource => resource.kind)).toEqual([
      'profile',
      'workspace',
      'cloud-session',
      'native-session',
      'fake-llm-scope',
    ]);
  });

  it.each(['session.open', undefined] as const)(
    'seeds the hosted workspace for a %s scenario',
    async scenarioId => {
      const cloud = new FakeCloud();
      const descriptorPath = await tempDescriptorPath();
      await prepareFixture({
        request: prepareRequest('cloud', descriptorPath, scenarioId),
        cloud,
        gitUrl: 'https://github.com/octocat/Hello-World.git',
      });
      expect(cloud.workspaceSeeds).toEqual([`__e2e_scope__:${SCOPE}\n__fake__:idle`]);
    }
  );

  it('creates an empty hosted workspace for prompt.stream', async () => {
    const cloud = new FakeCloud();
    const descriptorPath = await tempDescriptorPath();
    await prepareFixture({
      request: prepareRequest('cloud', descriptorPath, 'prompt.stream'),
      cloud,
      gitUrl: 'https://github.com/octocat/Hello-World.git',
    });
    expect(cloud.workspaceSeeds).toEqual([undefined]);
  });

  it('refuses a non-clonable Cloud repository URL', async () => {
    const cloud = new FakeCloud();
    await expect(
      prepareFixture({
        request: prepareRequest('cloud', await tempDescriptorPath()),
        cloud,
        gitUrl: 'file:///tmp/repo',
      })
    ).rejects.toThrowError(/requires a clonable http\(s\) git URL/);
    expect(cloud.calls).toEqual([]);
  });

  it('refuses a request scope that does not match the run', async () => {
    const cloud = new FakeCloud();
    await expect(
      prepareFixture({
        request: { ...prepareRequest('local', await tempDescriptorPath()), fakeLlmScope: 'other' },
        cloud,
      })
    ).rejects.toThrowError(/does not match run scope/);
  });

  it('recovers a profile when hosted workspace creation fails', async () => {
    const cloud = new FakeCloud({ failCreateWorkspace: true });
    const descriptorPath = await tempDescriptorPath();
    await expect(
      prepareFixture({ request: prepareRequest('cloud', descriptorPath), cloud })
    ).rejects.toThrowError(/workspace creation failed/);
    expect(cloud.profiles.size).toBe(0);
    await expect(stat(descriptorPath)).rejects.toThrow();
  });

  it('retains the ownership profile when workspace deletion is unconfirmed', async () => {
    const cloud = new FakeCloud();
    cloud.waitWorkspaceGone = async () => false;
    // Force a post-resource failure: the descriptor parent is a regular file.
    const parentFile = await tempDescriptorPath('not-a-directory');
    await writeFile(parentFile, 'x');
    await expect(
      prepareFixture({
        request: prepareRequest('cloud', path.join(parentFile, 'descriptor.json')),
        cloud,
      })
    ).rejects.toThrow();
    expect(cloud.profiles.size).toBe(1);
    expect(cloud.calls).toContain('deleteWorkspace:worktree_1');
    expect(cloud.calls).not.toContain('deleteProfile:profile-1');
  });
});

describe('cleanupFixture', () => {
  it('is a clean no-op without a descriptor', async () => {
    const cloud = new FakeCloud();
    await expect(
      cleanupFixture({
        request: cleanupRequest('/tmp/descriptor.json', false),
        descriptor: undefined,
        cloud,
      })
    ).resolves.toEqual(emptyCleanup(RUN_ID));
    expect(cloud.calls).toEqual([]);
  });

  it('removes owned resources and releases only run-scoped gates', async () => {
    const cloud = new FakeCloud();
    const descriptor = await cloudDescriptor(cloud);
    cloud.gates = [`${SCOPE}-gate`, 'kilo-e2e-other-run-gate'];

    const result = await cleanupFixture({
      request: cleanupRequest('/tmp/descriptor.json'),
      descriptor,
      cloud,
    });

    expect(result.status).toBe('clean');
    expect(result.leftovers).toEqual([]);
    expect(cloud.calls).toContain(`releaseGate:${SCOPE}-gate`);
    expect(cloud.calls).not.toContain('releaseGate:kilo-e2e-other-run-gate');
    expect(cloud.calls).toContain('deleteWorkspace:worktree_1');
    expect(cloud.calls).toContain('deleteProfile:profile-1');
    expect(result.removed.map(resource => resource.kind)).toEqual([
      'fake-llm-gate',
      'workspace',
      'cloud-session',
      'native-session',
      'profile',
    ]);
  });

  it('is safe to run twice after the resources are gone', async () => {
    const cloud = new FakeCloud();
    const descriptor = await cloudDescriptor(cloud);
    await cleanupFixture({ request: cleanupRequest('/tmp/descriptor.json'), descriptor, cloud });
    const callsAfterFirst = [...cloud.calls];
    const second = await cleanupFixture({
      request: cleanupRequest('/tmp/descriptor.json'),
      descriptor,
      cloud,
    });
    expect(second.status).toBe('clean');
    expect(cloud.calls).toEqual(callsAfterFirst);
  });

  it('refuses a foreign workspace and reports it as a leftover', async () => {
    const cloud = new FakeCloud();
    const descriptor = await cloudDescriptor(cloud);
    cloud.worktrees.set('worktree_1', {
      userId: 'other-user',
      deletionStartedAt: null,
      deletionCompletedAt: null,
    });

    const result = await cleanupFixture({
      request: cleanupRequest('/tmp/descriptor.json'),
      descriptor,
      cloud,
    });

    expect(result.status).toBe('failed');
    expect(result.leftovers).toContainEqual({
      kind: 'workspace',
      id: 'worktree_1',
      reason: 'workspace is owned by a different local user',
    });
    expect(cloud.calls).not.toContain('deleteWorkspace:worktree_1');
  });

  it('refuses a descriptor whose ownership token does not match the profile', async () => {
    const cloud = new FakeCloud();
    const descriptor = await cloudDescriptor(cloud);
    const tampered = { ...descriptor, cleanup: { ...descriptor.cleanup, token: 'other-token' } };

    const result = await cleanupFixture({
      request: cleanupRequest('/tmp/descriptor.json'),
      descriptor: tampered,
      cloud,
    });

    expect(result.status).toBe('failed');
    expect(result.leftovers).toContainEqual({
      kind: 'profile',
      id: 'profile-1',
      reason: 'profile ownership marker does not match the descriptor',
    });
    expect(cloud.calls).not.toContain('deleteProfile:profile-1');
  });

  it('fails closed when ownership cannot be inspected', async () => {
    const cloud = new FakeCloud({ failInspect: true });
    const descriptor = await cloudDescriptor(cloud);
    const result = await cleanupFixture({
      request: cleanupRequest('/tmp/descriptor.json'),
      descriptor,
      cloud,
    });
    expect(result.status).toBe('failed');
    expect(result.leftovers[0]).toEqual({
      kind: 'resources',
      id: RUN_ID,
      reason: 'database unavailable',
    });
    expect(cloud.calls.some(call => call.startsWith('delete'))).toBe(false);
  });

  it('reports a failed gate cleanup without hiding owned resource cleanup', async () => {
    const cloud = new FakeCloud({ failListWaiters: true });
    const descriptor = await cloudDescriptor(cloud);
    const result = await cleanupFixture({
      request: cleanupRequest('/tmp/descriptor.json'),
      descriptor,
      cloud,
    });
    expect(result.status).toBe('failed');
    expect(result.leftovers).toContainEqual({
      kind: 'fake-llm-scope',
      id: SCOPE,
      reason: 'fake LLM unavailable',
    });
    expect(cloud.calls).toContain('deleteWorkspace:worktree_1');
  });

  it('reports a deletion that does not complete as a leftover', async () => {
    const cloud = new FakeCloud();
    const descriptor = await cloudDescriptor(cloud);
    cloud.waitWorkspaceGone = async () => false;
    const result = await cleanupFixture({
      request: cleanupRequest('/tmp/descriptor.json'),
      descriptor,
      cloud,
    });
    expect(result.status).toBe('failed');
    expect(result.leftovers).toContainEqual({
      kind: 'workspace',
      id: 'worktree_1',
      reason: 'workspace deletion did not complete before the cleanup deadline',
    });
    expect(result.leftovers).toContainEqual({
      kind: 'profile',
      id: 'profile-1',
      reason: 'profile retained until the owned workspace is removed',
    });
    expect(cloud.calls).not.toContain('deleteProfile:profile-1');
  });

  it('rejects a descriptor for another run id', async () => {
    const cloud = new FakeCloud();
    const descriptor = await cloudDescriptor(cloud);
    const result = await cleanupFixture({
      request: { ...cleanupRequest('/tmp/descriptor.json'), runId: 'other-run' },
      descriptor,
      cloud,
    });
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/run id does not match/);
  });
});

describe('directive templates', () => {
  it('scopes every scenario directive to the run', () => {
    const templates = directiveTemplates({ runId: RUN_ID, token: 'K1-TOKEN' });
    expect(templates.open).toBe(`__e2e_scope__:${SCOPE}\n__fake__:idle`);
    expect(templates.stream).toBe(`__e2e_scope__:${SCOPE}\n__fake__:echo:K1-TOKEN`);
    expect(templates.permission).toContain(`${SCOPE}-permission`);
    expect(templates.permission).toContain('__fake__:file:write:');
  });
});

describe('workspace ownership helper', () => {
  it('treats a completed tombstone as removed when the root session is gone', () => {
    expect(
      workspaceOwnership(
        {
          profile: null,
          worktree: {
            userId: USER_ID,
            deletionStartedAt: '2026-11-02T00:00:00Z',
            deletionCompletedAt: '2026-11-02T00:01:00Z',
          },
          session: null,
        },
        { userId: USER_ID, profileId: 'profile-1' }
      )
    ).toEqual({ owned: true });
  });

  it('rejects a foreign tombstone instead of counting it as removed', () => {
    expect(
      workspaceOwnership(
        {
          profile: null,
          worktree: {
            userId: 'other-user',
            deletionStartedAt: '2026-11-02T00:00:00Z',
            deletionCompletedAt: '2026-11-02T00:01:00Z',
          },
          session: null,
        },
        { userId: USER_ID, profileId: 'profile-1' }
      )
    ).toEqual({ owned: false, reason: 'workspace is owned by a different local user' });
  });

  it('rejects a session created with a different profile', () => {
    expect(
      workspaceOwnership(
        {
          profile: null,
          worktree: { userId: USER_ID, deletionStartedAt: null, deletionCompletedAt: null },
          session: { userId: USER_ID, profileId: 'other-profile' },
        },
        { userId: USER_ID, profileId: 'profile-1' }
      )
    ).toEqual({ owned: false, reason: 'root session was created with a different profile' });
  });
});

describe('fixture provider error', () => {
  it('keeps a typed code', () => {
    expect(new FixtureProviderError('scope', 'x').code).toBe('scope');
  });
});
