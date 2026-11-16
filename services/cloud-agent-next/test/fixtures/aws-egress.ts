import type { ScmAdmissionDependencies } from '../../src/scm-broker/admission.js';
import { vi } from 'vitest';
import type { Env } from '../../src/types.js';
import { ECS_TEST_CONFIG } from './aws-ecs.js';
import { encodeAwsEcsProviderRef } from '../../src/sandbox-control/aws-ecs-operation.js';
import { AWS_TEST_CONFIGURATION } from './aws-provider.js';
import { encodeAwsProviderRef } from '../../src/sandbox-control/aws-operation.js';
import {
  mintSandboxLaunchCredential,
  hashSandboxCredential,
} from '../../src/sandbox-control/credential.js';
import {
  mintAwsEgressCredential,
  mintAwsEgressCredentialUntil,
} from '../../src/egress/aws-credential.js';
import { grant, logicalId } from '../../src/scm-broker/test-fixtures.js';
import { createAwsEgressAdmission, type AwsEgressContext } from '../../src/egress/aws-admission.js';

const generation = '22222222-2222-4222-8222-222222222222';
const allocationId = '11111111-1111-4111-8111-111111111111';
const secret = 'worker-signing-test';
const credential = 'a'.repeat(64);
export async function awsEgressFixture(
  options: { provider?: 'aws' | 'aws-ecs'; now?: () => number } = {}
) {
  const provider = options.provider ?? 'aws';
  let now = options.now?.() ?? Date.now();
  const config = {
    ...AWS_TEST_CONFIGURATION,
    proxy: { generation, hostname: 'proxy.kilo.internal', caFingerprint: 'b'.repeat(64) },
  };
  const scope = grant();
  scope.provider = 'aws';
  scope.orgId = '11111111-1111-4111-8111-111111111111';
  scope.preparedAt = now - 1000;
  scope.expiresAt = now + 3_600_000;
  const ref = {
    provider: 'aws' as const,
    sandboxId: logicalId,
    intentId: allocationId,
    createdAt: now,
  };
  const context: AwsEgressContext = {
    sandboxId: logicalId,
    ownerId: scope.userId,
    provider: 'aws',
    containmentEnabled: true,
    allocation: { kind: 'creating', allocationId, providerRef: encodeAwsProviderRef(ref) },
    byoc: {
      organizationId: '11111111-1111-4111-8111-111111111111',
      credentialId: '22222222-2222-4222-8222-222222222222',
    },
    credentialHash: await hashSandboxCredential(credential),
    outboundContainerId: scope.outboundContainerId ?? null,
    grants: [scope],
    liveSessionIds: scope.members.map(member => member.sessionId),
    organizationId: scope.orgId,
    available: true,
    identityBinding: '',
    audit: true,
    operation: {
      ref,
      config,
      phase: 'launching',
      deadlineAt: now + 28_680_000,
      request: {
        clientToken: allocationId,
        imageIdentifier: config.imageIdentifier,
        imageVersion: config.imageVersion,
        ingressNetworkConnectors: [
          'arn:aws:lambda:us-east-1:aws:network-connector:aws-network-connector:NO_INGRESS',
        ],
        egressNetworkConnectors: [config.connectorArn],
        logging: { disabled: {} },
        maximumDurationInSeconds: 28_800,
        runHookPayload: '{}',
      },
    },
  };
  if (provider === 'aws-ecs') {
    const configuration = { ...ECS_TEST_CONFIG, proxy: config.proxy };
    const ecsRef = { ...ref, provider: 'aws-ecs' as const };
    scope.provider = 'aws-ecs';
    context.provider = 'aws-ecs';
    context.allocation.providerRef = encodeAwsEcsProviderRef(ecsRef);
    context.operation = {
      ref: ecsRef,
      config: configuration,
      phase: 'launching',
      requestAt: now,
      request: {
        cluster: configuration.clusterArn,
        taskDefinition: configuration.taskDefinitionArn,
        capacityProviderStrategy: [{ capacityProvider: configuration.capacityProvider, weight: 1 }],
        count: 1,
        clientToken: allocationId,
        startedBy: allocationId,
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: [configuration.subnetId],
            securityGroups: [configuration.securityGroupId],
            assignPublicIp: 'DISABLED',
          },
        },
        overrides: {
          containerOverrides: [{ name: 'sandbox', command: ['-e', 'void 0'], environment: [] }],
        },
        enableExecuteCommand: false,
      },
    };
  }
  if (!context.operation) throw new Error('Missing operation');
  const pinnedConfiguration = context.operation.config;
  const metadata = {
    deployment: {
      protocolVersion: 1 as const,
      generation,
      stackId: config.stackId,
      hostname: config.proxy.hostname,
      port: 3128 as const,
      caFingerprint: config.proxy.caFingerprint,
      caCertificate: 'public-ca'.repeat(20),
      expiresAt: new Date(now + 86_400_000).toISOString(),
    },
    identity: {
      protocolVersion: 1 as const,
      generation,
      stackId: config.stackId,
      secret: 'c'.repeat(64),
    },
  };
  const proof = {
    credential: (provider === 'aws'
      ? mintAwsEgressCredential
      : (identity: Parameters<typeof mintAwsEgressCredential>[0], key: string) =>
          mintAwsEgressCredentialUntil(identity, key, Date.parse(metadata.deployment.expiresAt)))(
      {
        launchCredential: mintSandboxLaunchCredential(
          { sandboxId: logicalId, allocationId, credential },
          secret
        ),
        generation,
        stackId: config.stackId,
      },
      secret
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
  } as unknown as Env;
  const api = createAwsEgressAdmission({
    env,
    serial: async operation => operation(),
    readContext: async () => structuredClone(context),
    resolveConfiguration,
    readMetadata,
    signingSecret: async () => secret,
    resolve,
    persist,
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
