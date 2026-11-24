import type { ScmAdmissionDependencies } from '../../src/scm-broker/admission.js';
import { vi } from 'vitest';
import type { Env } from '../../src/types.js';
import { ECS_TEST_CONFIG } from './aws-ecs.js';
import { encodeAwsEcsProviderRef } from '../../src/sandbox-control/aws-ecs-operation.js';
import {
  mintSandboxLaunchCredential,
  hashSandboxCredential,
} from '../../src/sandbox-control/credential.js';
import { mintAwsEgressCredential } from '../../src/egress/aws-credential.js';
import { grant, logicalId } from '../../src/scm-broker/test-fixtures.js';
import { createAwsSandboxEgress } from '../../src/egress/aws-sandbox-context.js';
import type { AwsEcsOperation } from '../../src/sandbox-control/aws-ecs-operation.js';

type SandboxContext = Awaited<
  ReturnType<Parameters<typeof createAwsSandboxEgress>[0]['readContext']>
>;
/** The DO supplies the operation, credential hash and policy separately; tests mutate them here. */
type AwsEgressFixtureContext = SandboxContext & {
  operation: AwsEcsOperation | null;
  credentialHash?: string;
  allowlist?: readonly string[];
  audit: boolean;
};

const generation = '22222222-2222-4222-8222-222222222222';
const allocationId = '11111111-1111-4111-8111-111111111111';
const secret = 'worker-signing-test';
const credential = 'a'.repeat(64);
export async function awsEgressFixture(options: { now?: () => number } = {}) {
  let now = options.now?.() ?? Date.now();
  const certificateExpiresAt = Math.floor((now + 86_400_000) / 1000) * 1000;
  const config = {
    ...ECS_TEST_CONFIG,
    proxy: { generation, hostname: 'proxy.kilo.internal', caFingerprint: 'b'.repeat(64) },
  };
  const scope = grant();
  scope.provider = 'aws-ecs';
  scope.orgId = '11111111-1111-4111-8111-111111111111';
  scope.preparedAt = now - 1000;
  scope.expiresAt = now + 3_600_000;
  const ref = {
    provider: 'aws-ecs' as const,
    sandboxId: logicalId,
    intentId: allocationId,
    createdAt: now,
  };
  const context: AwsEgressFixtureContext = {
    sandboxId: logicalId,
    ownerId: scope.userId,
    provider: 'aws-ecs',
    containmentEnabled: true,
    allocation: { kind: 'creating', allocationId, providerRef: encodeAwsEcsProviderRef(ref) },
    byoc: {
      organizationId: '11111111-1111-4111-8111-111111111111',
      credentialId: '22222222-2222-4222-8222-222222222222',
    },
    credentialHash: await hashSandboxCredential(credential),
    outboundContainerId: scope.outboundContainerId ?? null,
    grants: [scope],
    liveSessionIds: scope.members.map(member => member.sessionId),
    organizationId: scope.orgId,
    audit: true,
    operation: {
      ref,
      config,
      phase: 'launching',
      requestAt: now,
      deadlineAt: certificateExpiresAt,
      request: {
        cluster: config.clusterArn,
        taskDefinition: config.taskDefinitionArn,
        capacityProviderStrategy: [{ capacityProvider: config.capacityProvider, weight: 1 }],
        count: 1,
        clientToken: allocationId,
        startedBy: allocationId,
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: [config.subnetId],
            securityGroups: [config.securityGroupId],
            assignPublicIp: 'DISABLED',
          },
        },
        overrides: {
          containerOverrides: [{ name: 'sandbox', command: ['-e', 'void 0'], environment: [] }],
        },
        enableExecuteCommand: false,
      },
    },
  };
  const pinnedConfiguration = config;
  const metadata = {
    deployment: {
      protocolVersion: 1 as const,
      generation,
      stackId: config.stackId,
      hostname: config.proxy.hostname,
      port: 3128 as const,
      caFingerprint: config.proxy.caFingerprint,
      caCertificate: 'public-ca'.repeat(20),
      expiresAt: new Date(certificateExpiresAt).toISOString(),
    },
    identity: {
      protocolVersion: 1 as const,
      generation,
      stackId: config.stackId,
      secret: 'c'.repeat(64),
    },
  };
  const proof = {
    credential: mintAwsEgressCredential(
      {
        launchCredential: mintSandboxLaunchCredential(
          { sandboxId: logicalId, allocationId, credential },
          secret
        ),
        generation,
        stackId: config.stackId,
      },
      secret,
      certificateExpiresAt
    ),
    identity: metadata.identity.secret,
  };
  const resolveConfiguration = vi.fn(async () => pinnedConfiguration);
  const readMetadata = vi.fn(async () => structuredClone(metadata));
  const resolve = vi.fn<ScmAdmissionDependencies['resolve']>(async ({ grant: current }) => {
    const credential = current.scm?.capability?.credential;
    if (!credential) throw new Error('Missing fixture capability');
    return { grant: current, credential };
  });
  const persist = vi.fn();
  const recordEgressRequest = vi.fn(async (_row: unknown) => undefined);
  const redeem = vi.fn(async () => ({ success: true, authorization: 'Bearer upstream-secret' }));
  const env = {
    GIT_TOKEN_SERVICE: { redeemGitHubSessionCapability: redeem },
    SANDBOX_CONTAINERS: { getByName: () => ({ recordEgressRequest }) },
    WORKER_URL: 'https://agent.example.com',
  } as unknown as Env;
  const unexpected = (operation: string) => async () => {
    throw new Error(`Unexpected egress operation ${operation}`);
  };
  const api = createAwsSandboxEgress({
    env,
    admission: { serial: async operation => operation(), resolve, persist },
    readContext: async () => structuredClone(context),
    operationStorage: {
      get: async () => structuredClone(context.operation),
      list: unexpected('list'),
      delete: unexpected('deletion'),
      transaction: unexpected('update'),
    } as unknown as Parameters<typeof createAwsSandboxEgress>[0]['operationStorage'],
    readCredentialHash: async () => context.credentialHash,
    readPolicy: () => ({ allowlist: context.allowlist, audit: context.audit }),
    resolveConfiguration,
    readMetadata,
    signingSecret: async () => secret,
    now: () => options.now?.() ?? now,
  });
  return {
    api,
    env,
    metadata,
    proof,
    context,
    config: pinnedConfiguration,
    scope,
    resolveConfiguration,
    readMetadata,
    resolve,
    persist,
    recordEgressRequest,
    redeem,
    now,
    setNow: (value: number) => {
      now = value;
    },
  };
}
