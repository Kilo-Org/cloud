import { RUNTIME_BASE_ABI } from '../../../src/sandbox-control/runtime-release.js';
import type { GitHubTaskGrant, GitHubTaskScope } from '@kilocode/worker-utils/github-task-grant';

export const FAKE_DOWNLOADED_RUNTIME_ENV = {
  RUNTIME_STARTUP_MODE: 'downloaded',
  NATIVE_RUNTIME_IMAGE: 'runtime-free',
  RUNTIME_INTERACTIVE_ORG_IDS: undefined,
  RUNTIME_RELEASE_DESCRIPTOR: JSON.stringify({
    format: 1,
    bootstrap: 1,
    platform: { os: 'linux', arch: 'x64', libc: 'glibc', cpu: 'baseline' },
    abi: RUNTIME_BASE_ABI,
    cliVersion: '7.8.1',
    cliExecutable: 'package/bin/kilo',
    wrapperSdkVersion: '7.8.1',
    protocol: '1',
    artifacts: [
      { role: 'cli', sha256: 'a'.repeat(64), transferBytes: 1, expandedBytes: 1, fileCount: 1 },
      { role: 'control', sha256: 'b'.repeat(64), transferBytes: 1, expandedBytes: 1, fileCount: 1 },
    ],
    caps: { maxTransferBytes: 100, maxExpandedBytes: 100, maxFileCount: 10 },
    inventory: [
      ['cli', 'package/bin/kilo', 0o755, 1, 'a'.repeat(64)],
      ['control', 'usr/local/bin/wrapper', 0o755, 1, 'b'.repeat(64)],
    ],
  }),
  RUNTIME_RELEASE_BUCKET: { head: async () => ({ size: 1 }) },
};

/** Decoded-only fixture; authorization verification is covered by the runtime-proxy suite. */
export const FAKE_RUNTIME_AUTHORIZED_KILO_TOKEN =
  'eyJhbGciOiJub25lIn0.eyJydW50aW1lQXV0aG9yaXphdGlvbiI6eyJpZCI6InJhXzEifX0.c2ln';

import type { SandboxControlV2 } from '../../../src/control-plane/sandbox/sandbox-do.js';

/**
 * Shared fakes for the B3 credential tests. The git-token-service is a service
 * binding the Miniflare Worker test runtime does not provide, so capability
 * issuance is faked here; each call returns a distinct credential so tests can
 * observe fresh selection. `SANDBOX_CONTAINERS` is the native Durable Object
 * namespace the outbound-container-id derivation needs; the test worker
 * deliberately does not boot the container-backed Sandbox DO, so a
 * namespace-shaped stand-in that only implements `idFromName` is used.
 */
export type FakeCredentialBroker = {
  githubIssued: () => number;
  /** The repository each GitHub capability was issued for, by capability. */
  githubCapabilityRepositories: () => ReadonlyMap<string, string>;
  issueGitHubSessionCapability: (params: {
    githubRepo: string;
    taskScope?: GitHubTaskScope;
    allowUserAuthorization?: boolean;
  }) => Promise<{
    taskGrant: GitHubTaskGrant;
    success: true;
    capability: string;
    installationId: number;
    accountLogin: string;
    appType: 'standard' | 'lite';
    source: 'user' | 'installation';
  }>;
};

export function createFakeCredentialBroker(
  appType: 'standard' | 'lite' = 'standard'
): FakeCredentialBroker {
  let githubIssued = 0;
  const repositories = new Map<string, string>();
  return {
    githubIssued: () => githubIssued,
    githubCapabilityRepositories: () => repositories,
    async issueGitHubSessionCapability(params) {
      githubIssued += 1;
      if (!params.taskScope) throw new Error('Missing task scope');
      const [owner, name] = params.githubRepo.toLowerCase().split('/');
      const capability = `kgh3.${githubIssued}`;
      repositories.set(capability, params.githubRepo);
      return {
        taskGrant: {
          revision: 1,
          scopeId: params.taskScope.scopeId,
          taskRef: params.taskScope.taskRef,
          repository: {
            id: params.taskScope.repositoryId ?? 101,
            nodeId: 'R_fixture',
            owner,
            name,
          },
        },
        success: true as const,
        capability,
        installationId: 1,
        accountLogin: 'acme',
        appType,
        source: params.allowUserAuthorization ? ('user' as const) : ('installation' as const),
      };
    },
  };
}

export const FAKE_SANDBOX_CONTAINERS_NAMESPACE = {
  idFromName: (name: string) => ({ toString: () => `oc_${name}` }),
};

/**
 * Kept for suites restored before the native namespace rename; new code should
 * use {@link FAKE_SANDBOX_CONTAINERS_NAMESPACE}.
 */
export const FAKE_SANDBOX_CONTAINMENT_NAMESPACE = FAKE_SANDBOX_CONTAINERS_NAMESPACE;

export function fakeOutboundContainerId(logicalSandboxId: string): string {
  return FAKE_SANDBOX_CONTAINERS_NAMESPACE.idFromName(logicalSandboxId).toString();
}

/**
 * Installs the fakes a Sandbox DO fixture needs: the credential bindings the
 * fake-provider suite has no binding for, and a current organization membership
 * for the gate on organization-attributed grant issuance (the suite has no
 * Postgres binding). A suite that exercises a denial replaces
 * `organizationMembershipFor` afterwards.
 */
export function installFakeSandboxEnv(
  instance: Pick<SandboxControlV2, 'organizationMembershipFor'>,
  broker: FakeCredentialBroker,
  extra: Record<string, unknown> = {}
): void {
  Object.assign(Reflect.get(instance, 'env') as object, {
    GIT_TOKEN_SERVICE: broker,
    SANDBOX_CONTAINERS: FAKE_SANDBOX_CONTAINERS_NAMESPACE,
    WORKER_URL: 'https://worker.example.com',
    ...FAKE_DOWNLOADED_RUNTIME_ENV,
    ...extra,
  });
  instance.organizationMembershipFor = async () => true;
}
