import { describe, expect, it } from 'vitest';
import { CurrentSessionMetadataSchema } from '../persistence/session-metadata.js';
import { buildInputRecordSchema } from './store.js';
import { publishedSnapshotSchema } from './policy.js';
import {
  environmentReferenceSchema,
  environmentScopeSchema,
  sameEnvironmentScope,
  sessionReferenceOf,
  type EnvironmentScope,
} from './reference.js';

const ENVIRONMENT_ID = '11111111-1111-4111-8111-111111111111';
const OWNER = { type: 'user' as const, id: 'user-1' };

// Stored V1 values, as written before V2 existed. Each literal is the shape of
// HEAD's `environmentReferenceSchema`, `buildInputRecordSchema` and
// `publishedSnapshotSchema`. They must keep parsing.
const V1_REFERENCE = {
  environmentId: ENVIRONMENT_ID,
  owner: OWNER,
  configurationRevision: 4,
  repository: { platform: 'github', repoFullName: 'acme/widgets' },
};

const V1_BUILD_INPUT_RECORD = {
  reference: V1_REFERENCE,
  repoFullName: 'acme/widgets',
  commands: ['pnpm install'],
  plainVars: { CI: '1' },
};

const V1_PUBLISHED_SNAPSHOT = {
  buildId: '22222222-2222-4222-8222-222222222222',
  environmentId: ENVIRONMENT_ID,
  owner: OWNER,
  revision: 4,
  repository: { platform: 'github', repoFullName: 'acme/widgets' },
  sourceCommit: 'a'.repeat(40),
  sourceBranch: 'main',
  provider: 'cloudflare-containers',
  baseImage: 'registry.example/app:1',
  runtimeAbi: 'abi',
  runtimeRelease: null,
  builderInstance: 'standard-4',
  snapshotId: 'snap-1',
  capturedAt: 1,
  publishedAt: 2,
  setupDurationMs: 1_000,
};

const API = {
  identity: { platform: 'github' as const, repoFullName: 'acme/api' },
  repoFullName: 'acme/api',
  leaf: 'api',
};
const WEB = {
  identity: { platform: 'github' as const, repoFullName: 'acme/web' },
  repoFullName: 'acme/web',
  leaf: 'web',
};
const V2_SCOPE: EnvironmentScope = {
  environmentId: ENVIRONMENT_ID,
  owner: OWNER,
  configurationRevision: 2,
  repositories: [API, WEB],
};

describe('stored V1 values', () => {
  it('parses the V1 session reference, which also covers route rows and sandbox selection', () => {
    expect(environmentReferenceSchema.parse(V1_REFERENCE)).toEqual(V1_REFERENCE);
  });

  it('parses a V1 reference inside session metadata', () => {
    const metadata = CurrentSessionMetadataSchema.parse({
      metadataSchemaVersion: 2,
      identity: { sessionId: 'workspace_1', userId: 'user-1' },
      auth: {},
      environment: V1_REFERENCE,
      lifecycle: { version: 1, timestamp: 1 },
    });
    expect(metadata.environment).toEqual(V1_REFERENCE);
  });

  it('parses a V1 build input record', () => {
    expect(buildInputRecordSchema.parse(V1_BUILD_INPUT_RECORD)).toEqual(V1_BUILD_INPUT_RECORD);
  });

  it('parses a V1 published snapshot', () => {
    expect(publishedSnapshotSchema.parse(V1_PUBLISHED_SNAPSHOT)).toEqual(V1_PUBLISHED_SNAPSHOT);
  });
});

describe('V2 values', () => {
  const v2Reference = {
    ...V2_SCOPE,
    repositories: [
      { ...API, branch: 'kilo/quiet-river-abc' },
      { ...WEB, branch: 'feature/web' },
    ],
  };

  it('parses a V2 session reference whose every repository has a branch', () => {
    expect(environmentReferenceSchema.parse(v2Reference)).toEqual(v2Reference);
  });

  it('rejects a V2 session reference with a repository without a branch', () => {
    expect(() =>
      environmentReferenceSchema.parse({ ...v2Reference, repositories: [API, WEB] })
    ).toThrow();
  });

  it('rejects a reference with both alternatives, or with neither', () => {
    expect(() =>
      environmentReferenceSchema.parse({ ...v2Reference, repository: V1_REFERENCE.repository })
    ).toThrow();
    const { repository: _repository, ...neither } = V1_REFERENCE;
    expect(() => environmentReferenceSchema.parse(neither)).toThrow();
  });

  it('rejects an empty V2 repository list and an unsafe directory name', () => {
    expect(() => environmentReferenceSchema.parse({ ...v2Reference, repositories: [] })).toThrow();
    expect(() =>
      environmentReferenceSchema.parse({
        ...v2Reference,
        repositories: [{ ...API, leaf: '..', branch: 'main' }],
      })
    ).toThrow();
  });

  it('parses a V2 scope without branches, and a V2 build input record that holds it', () => {
    expect(environmentScopeSchema.parse(V2_SCOPE)).toEqual(V2_SCOPE);
    const record = { reference: V2_SCOPE, commands: [], plainVars: {} };
    expect(buildInputRecordSchema.parse(record)).toEqual(record);
  });

  it('rejects a V2 build input record that also stores a V1 path', () => {
    expect(() =>
      buildInputRecordSchema.parse({
        reference: V2_SCOPE,
        repoFullName: 'acme/api',
        commands: [],
        plainVars: {},
      })
    ).toThrow();
  });

  it('parses a V2 published snapshot that stores one pin for each repository', () => {
    const {
      repository: _repository,
      sourceCommit: _commit,
      sourceBranch: _branch,
      ...common
    } = V1_PUBLISHED_SNAPSHOT;
    const snapshot = {
      ...common,
      repositories: [
        { repoFullName: 'acme/api', commit: 'a'.repeat(40), branch: 'main' },
        { repoFullName: 'acme/web', commit: 'b'.repeat(40), branch: 'main' },
      ],
    };
    expect(publishedSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });
});

describe('sessionReferenceOf', () => {
  const launch = API.identity;

  it('returns a V1 scope unchanged', () => {
    const scope = environmentScopeSchema.parse(V1_REFERENCE);
    expect(
      sessionReferenceOf(scope, {
        generatedBranch: 'kilo/x',
        launch,
        launchBranch: undefined,
        requested: [],
      })
    ).toEqual(V1_REFERENCE);
  });

  it('gives the launch repository the generated branch when it has no upstream branch', () => {
    const reference = sessionReferenceOf(V2_SCOPE, {
      generatedBranch: 'kilo/quiet-river-abc',
      launch,
      launchBranch: undefined,
      requested: [],
    });
    expect(reference.repositories?.map(entry => [entry.repoFullName, entry.branch])).toEqual([
      ['acme/api', 'kilo/quiet-river-abc'],
      ['acme/web', 'kilo/quiet-river-abc'],
    ]);
  });

  it('gives the launch repository its upstream branch and others the requested or generated branch', () => {
    const scope: EnvironmentScope = {
      ...V2_SCOPE,
      repositories: [
        API,
        WEB,
        {
          identity: { platform: 'github', repoFullName: 'acme/docs' },
          repoFullName: 'acme/docs',
          leaf: 'docs',
        },
      ],
    };
    const reference = sessionReferenceOf(scope, {
      generatedBranch: 'kilo/quiet-river-abc',
      launch,
      launchBranch: 'release/1',
      requested: [
        { repoFullName: 'Acme/Web', branch: 'feature/web' },
        { repoFullName: 'acme/docs' },
      ],
    });
    expect(reference.repositories?.map(entry => [entry.repoFullName, entry.branch])).toEqual([
      ['acme/api', 'release/1'],
      ['acme/web', 'feature/web'],
      ['acme/docs', 'kilo/quiet-river-abc'],
    ]);
  });

  it('finds the launch repository by identity for a platform whose identity is not a path', () => {
    const bitbucketScope: EnvironmentScope = {
      ...V2_SCOPE,
      repositories: [
        {
          identity: {
            platform: 'bitbucket',
            workspaceUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            repositoryUuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          },
          repoFullName: 'team/repo',
          leaf: 'repo',
        },
        WEB,
      ],
    };
    const reference = sessionReferenceOf(bitbucketScope, {
      generatedBranch: 'kilo/g',
      launch: {
        platform: 'bitbucket',
        workspaceUuid: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
        repositoryUuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      },
      launchBranch: 'main',
      requested: [],
    });
    expect(reference.repositories?.map(entry => entry.branch)).toEqual(['main', 'kilo/g']);
  });

  it('produces a value the session schema accepts', () => {
    const reference = sessionReferenceOf(V2_SCOPE, {
      generatedBranch: 'kilo/quiet-river-abc',
      launch,
      launchBranch: undefined,
      requested: [],
    });
    expect(environmentReferenceSchema.parse(reference)).toEqual(reference);
  });
});

describe('sameEnvironmentScope', () => {
  const bitbucket = (repositoryUuid: string) => ({
    environmentId: ENVIRONMENT_ID,
    owner: OWNER,
    repository: {
      platform: 'bitbucket' as const,
      workspaceUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      repositoryUuid,
    },
  });

  it('compares V1 scopes by identity, so two Bitbucket repositories differ', () => {
    const one = bitbucket('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    expect(sameEnvironmentScope(one, bitbucket('BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB'))).toBe(true);
    expect(sameEnvironmentScope(one, bitbucket('cccccccc-cccc-4ccc-8ccc-cccccccccccc'))).toBe(
      false
    );
  });

  it('compares V2 scopes by their ordered repositories', () => {
    expect(sameEnvironmentScope(V2_SCOPE, { ...V2_SCOPE })).toBe(true);
    expect(sameEnvironmentScope(V2_SCOPE, { ...V2_SCOPE, repositories: [WEB, API] })).toBe(false);
    expect(sameEnvironmentScope(V2_SCOPE, { ...V2_SCOPE, repositories: [API] })).toBe(false);
  });

  it('compares a V2 scope with a published descriptor that lists commits, ignoring path case', () => {
    const published = {
      environmentId: V2_SCOPE.environmentId,
      owner: V2_SCOPE.owner,
      repositories: V2_SCOPE.repositories.map(({ repoFullName }) => ({
        repoFullName: repoFullName.toUpperCase(),
        commit: 'a'.repeat(40),
      })),
    };
    expect(sameEnvironmentScope(published, V2_SCOPE)).toBe(true);
    expect(sameEnvironmentScope({ ...published, owner: { type: 'user', id: 'u' } }, V2_SCOPE)).toBe(
      false
    );
  });

  it('never matches a V1 value with a V2 value', () => {
    const v1 = {
      ...bitbucket('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
      environmentId: V2_SCOPE.environmentId,
      owner: V2_SCOPE.owner,
    };
    expect(sameEnvironmentScope(v1, V2_SCOPE)).toBe(false);
    expect(sameEnvironmentScope(V2_SCOPE, v1)).toBe(false);
  });
});
