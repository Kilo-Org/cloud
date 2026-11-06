import { RUNTIME_BASE_ABI } from '../../../src/sandbox-control/runtime-release.js';

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
  issueGitHubSessionCapability: (params?: { githubRepo?: string }) => Promise<{
    success: true;
    capability: string;
    installationId: number;
    accountLogin: string;
    appType: 'standard' | 'lite';
    source: 'managed';
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
      const capability = `kgh2.${githubIssued}`;
      if (params?.githubRepo) repositories.set(capability, params.githubRepo);
      return {
        success: true as const,
        capability,
        installationId: 1,
        accountLogin: 'acme',
        appType,
        source: 'managed' as const,
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

export function installFakeCredentialEnv(
  target: unknown,
  broker: FakeCredentialBroker,
  extra: Record<string, unknown> = {}
): void {
  Object.assign(target as object, {
    GIT_TOKEN_SERVICE: broker,
    SANDBOX_CONTAINERS: FAKE_SANDBOX_CONTAINERS_NAMESPACE,
    WORKER_URL: 'https://worker.example.com',
    ...FAKE_DOWNLOADED_RUNTIME_ENV,
    ...extra,
  });
}
