import type { ScmAdmissionDependencies } from '../../src/scm-broker/admission.js';
import { vi } from 'vitest';
import type { Env } from '../../src/types.js';
import { EC2_TEST_CONFIG } from './aws-ec2.js';
import { awsEc2Ref, type AwsEc2Workspace } from '../../src/sandbox-control/aws-ec2-lifecycle.js';
import { hashSandboxCredential } from '../../src/sandbox-control/credential.js';
import { mintAwsEc2EgressCredential } from '../../src/egress/aws-credential.js';
import { grant, logicalId } from '../../src/scm-broker/test-fixtures.js';
import { createAwsSandboxEgress } from '../../src/egress/aws-sandbox-context.js';

type SandboxContext = Awaited<
  ReturnType<Parameters<typeof createAwsSandboxEgress>[0]['readContext']>
>;
/** The DO supplies the workspace and policy separately; tests mutate them here. */
type AwsEgressFixtureContext = SandboxContext & {
  workspace: AwsEc2Workspace | null;
  allowlist?: readonly string[];
  audit: boolean;
};

const generation = '22222222-2222-4222-8222-222222222222';
const allocationId = '11111111-1111-4111-8111-111111111111';
const secret = 'worker-signing-test';
const credential = 'a'.repeat(64);
export async function awsEgressFixture(options: { now?: () => number } = {}) {
  let now = options.now?.() ?? Date.now();
  const expiresAt = Math.floor((now + 86_400_000) / 1000) * 1000;
  const config = { ...EC2_TEST_CONFIG };
  const scope = grant();
  scope.provider = 'aws-ec2';
  scope.orgId = '11111111-1111-4111-8111-111111111111';
  scope.preparedAt = now - 1000;
  scope.expiresAt = now + 3_600_000;
  const instanceId = 'i-0123456789abcdef0';
  const workspace: AwsEc2Workspace = {
    sandboxId: logicalId,
    config,
    generation,
    phase: 'starting',
    instanceId,
    createdForAllocation: allocationId,
    allocation: {
      id: allocationId,
      startedAt: now,
      egress: { expiresAt, identityHash: await hashSandboxCredential(credential) },
    },
  };
  const context: AwsEgressFixtureContext = {
    sandboxId: logicalId,
    ownerId: scope.userId,
    provider: 'aws-ec2',
    containmentEnabled: true,
    allocation: { kind: 'creating', allocationId, providerRef: awsEc2Ref(workspace) },
    byoc: {
      organizationId: '11111111-1111-4111-8111-111111111111',
      credentialId: '22222222-2222-4222-8222-222222222222',
    },
    outboundContainerId: scope.outboundContainerId ?? null,
    grants: [scope],
    liveSessionIds: scope.members.map(member => member.sessionId),
    organizationId: scope.orgId,
    audit: true,
    workspace,
  };
  const proof = {
    credential: mintAwsEc2EgressCredential(
      { sandboxId: logicalId, allocationId, generation, instanceId, stackId: config.stackId },
      secret,
      expiresAt
    ),
    identity: credential,
  };
  const resolveEc2Configuration = vi.fn(async () => config);
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
      get: async () => structuredClone(context.workspace),
      delete: unexpected('deletion'),
      transaction: unexpected('update'),
    } as unknown as Parameters<typeof createAwsSandboxEgress>[0]['operationStorage'],
    readPolicy: () => ({ allowlist: context.allowlist, audit: context.audit }),
    resolveEc2Configuration,
    signingSecret: async () => secret,
    now: () => options.now?.() ?? now,
  });
  return {
    api,
    env,
    proof,
    context,
    config,
    scope,
    resolveEc2Configuration,
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
