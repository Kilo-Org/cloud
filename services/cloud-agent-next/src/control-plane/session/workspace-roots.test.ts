import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { CurrentSessionMetadataSchema } from '../../persistence/session-metadata.js';
import {
  controlPlaneRegistrationRouteSpecSchema,
  controlPlaneRouteSpecSchema,
} from '../../shared/control-plane-protocol.js';
import { buildSessionAttachPayload } from '../../sandbox-session/attach-payload.js';
import { getControlPlaneSessionDirectory } from '../../workspace.js';
import {
  buildControlPlaneSessionRegistration,
  controlPlaneRouteSpecFromAttachPayload,
} from './registration.js';
import { rootBranchMode, sessionWorkspace } from './workspace-roots.js';

const KILO_TOKEN = jwt.sign(
  { runtimeAuthorization: { id: '11111111-1111-4111-8111-111111111111' } },
  'test'
);
const ENVIRONMENT_ID = '33333333-3333-4333-8333-333333333333';
const GENERATED = 'kilo/generated';
const LAUNCH_GIT = { url: 'https://github.com/acme/api.git', platform: 'github' as const };

function member(
  identity: Record<string, string>,
  repoFullName: string,
  branch = GENERATED
): Record<string, unknown> {
  return {
    identity,
    repoFullName,
    leaf: repoFullName.slice(repoFullName.indexOf('/') + 1),
    branch,
  };
}

const API = member({ platform: 'github', repoFullName: 'acme/api' }, 'acme/api');
const WEB = member({ platform: 'github', repoFullName: 'acme/web' }, 'acme/web', 'feature/web');
const DOCS = member(
  { platform: 'gitlab', cloneUrl: 'https://gitlab.com/group/docs.git' },
  'group/docs'
);
const INFRA = member(
  {
    platform: 'bitbucket',
    workspaceUuid: '{aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa}',
    repositoryUuid: '{bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb}',
  },
  'team/infra'
);

function metadata(options: {
  repositories?: Array<Record<string, unknown>>;
  sandboxId?: string;
  launchBranch?: string;
}) {
  const environment =
    options.repositories === undefined
      ? undefined
      : {
          environmentId: ENVIRONMENT_ID,
          owner: { type: 'user', id: 'usr_1' },
          configurationRevision: 1,
          repositories: options.repositories,
        };
  return CurrentSessionMetadataSchema.parse({
    metadataSchemaVersion: 2,
    identity: {
      sessionId: 'workspace_12345678-1234-1234-1234-123456789abc',
      userId: 'usr_1',
      createdOnPlatform: 'cloud-agent',
    },
    auth: { kiloSessionId: 'ses_12345678901234567890123456', kilocodeToken: KILO_TOKEN },
    agent: { mode: 'code', model: 'kilo/fake-deterministic' },
    repository: { type: 'github', repo: 'acme/api', upstreamBranch: options.launchBranch },
    workspace: {
      sandboxId: options.sandboxId ?? 'ses-0123456789abcdef',
      sandboxProvider: 'cloudflare',
      branchName: options.launchBranch ?? GENERATED,
      ...(environment ? { generatedBranchName: GENERATED } : {}),
    },
    ...(environment ? { environment } : {}),
    lifecycle: { version: 1, timestamp: 1 },
  });
}

describe('sessionWorkspace', () => {
  it('keeps a V1 session at its directory with no roots on the wire', () => {
    expect(sessionWorkspace(metadata({}), LAUNCH_GIT)).toEqual({ directory: '/workspace/app' });
  });

  it('keeps a V1 session on a shared sandbox at its per-session path', () => {
    const shared = metadata({ sandboxId: `usr-${'a'.repeat(48)}` });
    expect(sessionWorkspace(shared, LAUNCH_GIT)).toEqual({
      directory: expect.stringMatching(/^\/workspace\/.+workspace_12345678/),
    });
  });

  it('puts a one-repository V2 session at /workspace/<leaf> with one root', () => {
    expect(sessionWorkspace(metadata({ repositories: [API] }), LAUNCH_GIT)).toEqual({
      directory: '/workspace/api',
      roots: [
        {
          directory: '/workspace/api',
          repoFullName: 'acme/api',
          git: LAUNCH_GIT,
          branch: GENERATED,
          branchMode: 'working',
        },
      ],
    });
  });

  it('puts a several-repository V2 session at /workspace with a root for each repository', () => {
    const workspace = sessionWorkspace(
      metadata({ repositories: [API, WEB, DOCS, INFRA] }),
      LAUNCH_GIT
    );
    expect(workspace.directory).toBe('/workspace');
    expect(workspace.roots).toEqual([
      {
        directory: '/workspace/api',
        repoFullName: 'acme/api',
        git: LAUNCH_GIT,
        branch: GENERATED,
        branchMode: 'working',
      },
      {
        directory: '/workspace/web',
        repoFullName: 'acme/web',
        git: { url: 'https://github.com/acme/web.git', platform: 'github' },
        branch: 'feature/web',
      },
      {
        directory: '/workspace/docs',
        repoFullName: 'group/docs',
        git: { url: 'https://gitlab.com/group/docs.git', platform: 'gitlab' },
        branch: GENERATED,
        branchMode: 'working',
      },
      {
        directory: '/workspace/infra',
        repoFullName: 'team/infra',
        git: { url: 'https://bitbucket.org/team/infra.git', platform: 'bitbucket' },
        branch: GENERATED,
        branchMode: 'working',
      },
    ]);
  });

  it('checks the launch repository out on its requested branch, not in working mode', () => {
    const launch = member(
      { platform: 'github', repoFullName: 'acme/api' },
      'acme/api',
      'release/1'
    );
    const workspace = sessionWorkspace(
      metadata({ repositories: [launch, WEB], launchBranch: 'release/1' }),
      LAUNCH_GIT
    );
    expect(workspace.roots?.[0]).toEqual({
      directory: '/workspace/api',
      repoFullName: 'acme/api',
      git: LAUNCH_GIT,
      branch: 'release/1',
    });
  });

  it('refuses a V2 session on a shared sandbox', () => {
    expect(() =>
      sessionWorkspace(
        metadata({ repositories: [API, WEB], sandboxId: `usr-${'a'.repeat(48)}` }),
        LAUNCH_GIT
      )
    ).toThrow('A multi-repository environment needs an isolated workspace');
  });
});

describe('rootBranchMode', () => {
  it('is working only for the generated branch', () => {
    expect(rootBranchMode(GENERATED, GENERATED)).toBe('working');
    expect(rootBranchMode('feature/web', GENERATED)).toBeUndefined();
    expect(rootBranchMode(GENERATED, undefined)).toBeUndefined();
  });
});

describe('registration route spec of a V2 session', () => {
  const selection = { provider: 'cloudflare' as const };

  it('uses the cwd as the route directory and carries the roots', () => {
    const registration = buildControlPlaneSessionRegistration(
      metadata({ repositories: [API, WEB] }),
      selection
    );
    expect(registration.spec.directory).toBe('/workspace');
    expect(registration.spec.roots?.map(root => root.directory)).toEqual([
      '/workspace/api',
      '/workspace/web',
    ]);
    expect(registration.spec.git?.url).toBe(LAUNCH_GIT.url);
    // A root is a repository checkout and holds no credential.
    expect(JSON.stringify(registration.spec.roots)).not.toMatch(/token/i);
  });

  it('puts a one-repository V2 session at its repository directory', () => {
    const registration = buildControlPlaneSessionRegistration(
      metadata({ repositories: [API] }),
      selection
    );
    expect(registration.spec.directory).toBe('/workspace/api');
    expect(registration.spec.roots).toHaveLength(1);
  });

  it.each([
    ['an isolated', undefined],
    ['a shared', `usr-${'a'.repeat(48)}`],
  ])('sends %s V1 session exactly the route it always had', (_name, sandboxId) => {
    const v1 = metadata({ sandboxId });
    const registration = buildControlPlaneSessionRegistration(v1, selection);

    // The route as it was built before roots: the attach payload with the
    // directory the session directory function gives, and nothing else.
    const sessionDirectory = getControlPlaneSessionDirectory({
      workspacePath: v1.workspace?.workspacePath,
      sandboxId: v1.workspace?.sandboxId,
      sandboxKind: v1.workspace?.sandboxKind,
      orgId: v1.identity.orgId,
      userId: v1.identity.userId,
      sessionId: v1.identity.sessionId,
    });
    // Only the permission a non-interactive origin gets is added besides.
    const expected = controlPlaneRouteSpecSchema.parse({
      permission: { question: 'deny' },
      ...controlPlaneRouteSpecFromAttachPayload(
        { ...buildSessionAttachPayload(v1, undefined, undefined), directory: sessionDirectory },
        { sessionId: v1.identity.sessionId, kiloSessionId: registration.spec.kiloSessionId },
        { runtimeIsolation: 'per-session' }
      ),
    });
    expect(registration.spec).toEqual(expected);
    expect('roots' in registration.spec).toBe(false);
  });

  it('rejects a root outside the route directory', () => {
    const { spec } = buildControlPlaneSessionRegistration(
      metadata({ repositories: [API, WEB] }),
      selection
    );
    const outside = {
      ...spec,
      roots: spec.roots?.map(root => ({ ...root, directory: '/elsewhere/api' })),
    };
    expect(controlPlaneRegistrationRouteSpecSchema.safeParse(outside).success).toBe(false);
  });
});
