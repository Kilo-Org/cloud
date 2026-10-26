import type { GitHubTaskGrant, GitHubTaskScope } from '@kilocode/worker-utils/github-task-grant';
/** Decoded-only fixture; authorization verification is covered by the runtime-proxy suite. */
export const FAKE_RUNTIME_AUTHORIZED_KILO_TOKEN =
  'eyJhbGciOiJub25lIn0.eyJydW50aW1lQXV0aG9yaXphdGlvbiI6eyJpZCI6InJhXzEifX0.c2ln';

/**
 * Shared fakes for the B3 credential tests. The git-token-service is a service
 * binding the Miniflare Worker test runtime does not provide, so capability
 * issuance is faked here; each call returns a distinct credential so tests can
 * observe fresh selection. `SandboxContainment` is a Durable Object namespace
 * the outbound-container-id derivation needs; the test worker deliberately does
 * not boot the container-backed Sandbox DO, so a namespace-shaped stand-in that
 * only implements `idFromName` is used.
 */
export type FakeCredentialBroker = {
  kiloIssued: () => number;
  githubIssued: () => number;
  issueKiloSessionCapability: () => Promise<{ success: true; capability: string }>;
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
  let kiloIssued = 0;
  let githubIssued = 0;
  return {
    kiloIssued: () => kiloIssued,
    githubIssued: () => githubIssued,
    async issueKiloSessionCapability() {
      kiloIssued += 1;
      return { success: true as const, capability: `kka1.${kiloIssued}` };
    },
    async issueGitHubSessionCapability(params) {
      githubIssued += 1;
      if (!params.taskScope) throw new Error('Missing task scope');
      const [owner, name] = params.githubRepo.toLowerCase().split('/');
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
        capability: `kgh3.${githubIssued}`,
        installationId: 1,
        accountLogin: 'acme',
        appType,
        source: params.allowUserAuthorization ? ('user' as const) : ('installation' as const),
      };
    },
  };
}

export const FAKE_SANDBOX_CONTAINMENT_NAMESPACE = {
  idFromName: (name: string) => ({ toString: () => `oc_${name}` }),
};

export function fakeOutboundContainerId(logicalSandboxId: string): string {
  return `oc_${logicalSandboxId}`;
}

export function installFakeCredentialEnv(
  target: unknown,
  broker: FakeCredentialBroker,
  extra: Record<string, unknown> = {}
): void {
  Object.assign(target as object, {
    GIT_TOKEN_SERVICE: broker,
    SandboxContainment: FAKE_SANDBOX_CONTAINMENT_NAMESPACE,
    // The fake harness asserts contained grants unless a test opts out; the
    // local `.dev.vars` value must not decide what a test means.
    CREDENTIAL_CONTAINMENT_ENABLED: 'true',
    WORKER_URL: 'https://worker.example.com',
    ...extra,
  });
}
