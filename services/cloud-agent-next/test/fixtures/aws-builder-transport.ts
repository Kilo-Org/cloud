import type { GitTokenService } from '../../src/types.js';
import { generateKeyPairSync } from 'node:crypto';
import { encryptKeyedEnvelope, parseKeyedEnvelope } from '@kilocode/encryption';
import {
  AWS_BYOC_ENVELOPE_KEY_ID,
  AWS_BYOC_ENVELOPE_SCHEME,
} from '@kilocode/worker-utils/aws-byoc';
import { AWS_ECS_BYOC_ENVELOPE_SCHEME } from '@kilocode/worker-utils/aws-ecs';
import { AWS_EGRESS_PUBLIC_KEY, AWS_EGRESS_SHARED_KEY } from '@kilocode/worker-utils/aws-egress';
import { sha256Hex } from '@kilocode/worker-utils/sha256';
import { byocOwnerKey } from '../../src/byoc/owner.js';
import {
  microvmRunRequestSchema,
  type Microvm,
} from '../../src/agent-sandbox/aws/microvm-client.js';
import { ecsRunRequestSchema } from '../../src/agent-sandbox/aws/ecs-client.js';
import { environmentBuildRunnerSchema } from '../../src/shared/environment-build-protocol.js';
import { AWS_TEST_CONFIGURATION } from './aws-provider.js';
import { ECS_TEST_CONFIG, ecsDefinition, ecsTask } from './aws-ecs.js';

export const AWS_BUILD_TEST_OWNER = {
  type: 'organization' as const,
  id: '22222222-2222-4222-8222-222222222222',
};
export const AWS_BUILD_TEST_CREDENTIAL_ID = '44444444-4444-4444-8444-444444444444';
export const AWS_BUILD_TEST_SECRET = 'synthetic-build-signing-secret';
const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;');

/** Simulate AWS HTTP only. Production signing, validation, adapters and durable state stay real. */
export async function awsBuilderTransport(provider: 'aws' | 'aws-ecs') {
  const caCertificate = `-----BEGIN CERTIFICATE-----\n${'synthetic-public-ca'.repeat(12)}\n-----END CERTIFICATE-----`;
  const proxy = { ...ECS_TEST_CONFIG.proxy, caFingerprint: await sha256Hex(caCertificate) };
  const config =
    provider === 'aws' ? { ...AWS_TEST_CONFIGURATION, proxy } : { ...ECS_TEST_CONFIG, proxy };
  const source = {
    organizationId: AWS_BUILD_TEST_OWNER.id,
    credentialId: AWS_BUILD_TEST_CREDENTIAL_ID,
  };
  const scheme = provider === 'aws' ? AWS_BYOC_ENVELOPE_SCHEME : AWS_ECS_BYOC_ENVELOPE_SCHEME;
  const purpose = provider === 'aws' ? 'byoc-aws-configuration' : 'byoc-aws-ecs-configuration';
  const envelope = parseKeyedEnvelope(
    encryptKeyedEnvelope(
      JSON.stringify(config),
      scheme,
      { keyId: AWS_BYOC_ENVELOPE_KEY_ID, publicKeyPem: keys.publicKey },
      `${purpose}:v1:${byocOwnerKey(source)}:${source.credentialId}`
    ),
    scheme
  );
  const identity = {
    protocolVersion: 1,
    generation: proxy.generation,
    stackId: config.stackId,
    secret: 'e'.repeat(64),
  };
  const deployment = {
    protocolVersion: 1,
    generation: proxy.generation,
    stackId: config.stackId,
    hostname: proxy.hostname,
    port: 3128,
    caCertificate,
    caFingerprint: proxy.caFingerprint,
    expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
  };
  const objects = new Map<string, { bytes: Uint8Array; checksum?: string }>();
  const deleted: string[] = [];
  const requests = new Map<string, string>();
  const vms = new Map<string, Microvm>();
  const tasks = new Map<string, ReturnType<typeof ecsTask>>();
  const runStarted = Promise.withResolvers<void>();
  let onRun = async () => {};
  let loseReply = false;
  let runCalls = 0;
  let checkpoint: (request: unknown) => Promise<void> = async () => {};
  let onIssue = async () => {};
  const issueStarted = Promise.withResolvers<void>();
  let issued = 0;
  let issueFailure:
    | Extract<
        Awaited<ReturnType<GitTokenService['issueGitHubSessionCapability']>>,
        { success: false }
      >
    | undefined;
  const brokerCalls: unknown[] = [];
  const redemptions: unknown[] = [];
  const forwarded: string[] = [];
  const outputs: Record<string, string> = {
    RoleArn: config.roleArn,
    Bucket: config.bucket,
    TemplateVersion: String(config.templateVersion),
    ProxyProtocolVersion: '1',
    ProxyHostname: proxy.hostname,
    ...('clusterArn' in config
      ? {
          Provider: 'aws-ecs',
          ClusterArn: config.clusterArn,
          TaskDefinitionArn: config.taskDefinitionArn,
          CapacityProvider: config.capacityProvider,
          ExecutionRoleArn: config.executionRoleArn,
          RuntimeImage: config.runtimeImage,
          PrivateSubnet: config.subnetId,
          SandboxSecurityGroup: config.securityGroupId,
        }
      : {
          ImageArn: config.imageIdentifier,
          ImageVersion: config.imageVersion,
          ConnectorArn: config.connectorArn,
        }),
  };
  async function run(request: { clientToken: string }, body: string) {
    await checkpoint(request);
    const existing = requests.get(request.clientToken);
    if (existing && existing !== body) throw new Error('Test observed non-idempotent AWS replay');
    requests.set(request.clientToken, body);
    runCalls++;
  }
  const errors: string[] = [];
  const handler: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.hostname === 'backend.test') {
      if (
        url.searchParams.get('provider') !== provider ||
        url.searchParams.get('organizationId') !== source.organizationId
      )
        throw new Error('Test observed different connection authority');
      return Response.json({ ...source, setupStatus: 'ready', credentialsEncrypted: envelope });
    }
    if (url.hostname.startsWith('sts.'))
      return new Response(
        `<AssumeRoleResponse><AssumeRoleResult><Credentials><AccessKeyId>ASIACUSTOMER00000000</AccessKeyId><SecretAccessKey>KiloSecret0000000000000000000000000000000</SecretAccessKey><SessionToken>syntheticSessionToken</SessionToken><Expiration>${deployment.expiresAt}</Expiration></Credentials></AssumeRoleResult></AssumeRoleResponse>`
      );
    if (url.hostname.startsWith('cloudformation.'))
      return new Response(
        `<DescribeStacksResponse><DescribeStacksResult><Stacks><member><StackId>${xml(config.stackId)}</StackId><StackName>customer</StackName><StackStatus>CREATE_COMPLETE</StackStatus><Outputs>${Object.entries(
          outputs
        )
          .map(
            ([key, value]) =>
              `<member><OutputKey>${key}</OutputKey><OutputValue>${xml(value)}</OutputValue></member>`
          )
          .join('')}</Outputs></member></Stacks></DescribeStacksResult></DescribeStacksResponse>`
      );
    if (url.hostname === `${config.bucket}.s3.us-east-1.amazonaws.com`) {
      const key = url.pathname.slice(1);
      if (key === AWS_EGRESS_PUBLIC_KEY) return Response.json(deployment);
      if (key === AWS_EGRESS_SHARED_KEY) return Response.json(identity);
      if (request.method === 'PUT') {
        if (request.headers.get('if-none-match') !== '*')
          throw new Error('Missing immutable object condition');
        if (objects.has(key)) return new Response(null, { status: 412 });
        const bytes = new Uint8Array(await request.arrayBuffer());
        const checksum = request.headers.get('x-amz-checksum-sha256') ?? undefined;
        objects.set(key, { bytes, checksum });
        return new Response(null);
      }
      if (request.method === 'DELETE') {
        deleted.push(key);
        objects.delete(key);
        return new Response(null);
      }
      const object = objects.get(key);
      if (!object) return new Response(null, { status: 404 });
      return new Response(request.method === 'HEAD' ? null : object.bytes, {
        headers: {
          'content-length': String(object.bytes.byteLength),
          ...(object.checksum ? { 'x-amz-checksum-sha256': object.checksum } : {}),
        },
      });
    }
    if (url.hostname.startsWith('lambda.')) {
      if (request.method === 'POST') {
        const body = await request.text();
        const launch = microvmRunRequestSchema.parse(JSON.parse(body));
        await run(launch, body);
        let vm = vms.get(launch.clientToken);
        if (!vm) {
          vm = {
            microvmId: `microvm-${vms.size + 1}`,
            imageArn: launch.imageIdentifier,
            imageVersion: launch.imageVersion,
            maximumDurationInSeconds: launch.maximumDurationInSeconds,
            state: 'RUNNING',
            ingressNetworkConnectors: launch.ingressNetworkConnectors,
            egressNetworkConnectors: launch.egressNetworkConnectors,
          };
          vms.set(launch.clientToken, vm);
        }
        runStarted.resolve();
        await onRun();
        if (loseReply) {
          loseReply = false;
          throw new Error('Synthetic lost Run reply');
        }
        return Response.json(vm);
      }
      const vm = [...vms.values()].find(
        value => value.microvmId === url.pathname.split('/').at(-1)
      );
      if (!vm) return new Response(null, { status: 404 });
      if (request.method === 'DELETE') {
        vm.state = 'TERMINATED';
        return new Response(null);
      }
      return Response.json(vm);
    }
    if (url.hostname.startsWith('ecs.')) {
      const body = await request.text();
      const action = request.headers.get('x-amz-target')?.split('.').at(-1);
      if (action === 'DescribeTaskDefinition')
        return Response.json({ taskDefinition: ecsDefinition() });
      if (action === 'RunTask') {
        const launch = ecsRunRequestSchema.parse(JSON.parse(body));
        await run(launch, body);
        let task = tasks.get(launch.clientToken);
        if (!task) {
          task = {
            ...ecsTask(),
            taskArn: ecsTask().taskArn.replace(
              'd'.repeat(32),
              (tasks.size + 1).toString(16).padStart(32, '0')
            ),
          };
          tasks.set(launch.clientToken, task);
        }
        runStarted.resolve();
        await onRun();
        if (loseReply) {
          loseReply = false;
          throw new Error('Synthetic lost Run reply');
        }
        return Response.json({ tasks: [task], failures: [] });
      }
      const lookup = JSON.parse(body) as { task?: string; tasks?: string[] };
      const task = [...tasks.values()].find(
        value => value.taskArn === (lookup.task ?? lookup.tasks?.[0])
      );
      if (action === 'StopTask' && task) {
        task.lastStatus = 'STOPPED';
        return Response.json({ task });
      }
      if (action === 'DescribeTasks')
        return Response.json({ tasks: task ? [task] : [], failures: [] });
    }
    if (url.hostname === 'github.com') {
      if (request.headers.get('authorization') !== 'Bearer synthetic-upstream-token')
        throw new Error('Test upstream received a broker alias');
      forwarded.push(url.pathname);
      return new Response('synthetic git response');
    }
    throw new Error('Unexpected test transport request');
  };
  return {
    errors,
    transport: (async (...args) => {
      try {
        return await handler(...args);
      } catch (error) {
        errors.push(String(error));
        throw error;
      }
    }) satisfies typeof fetch,
    provider,
    config,
    privateKey: keys.privateKey,
    identity,
    objects,
    deleted,
    requests,
    vms,
    tasks,
    runStarted: runStarted.promise,
    issueStarted: issueStarted.promise,
    brokerCalls,
    redemptions,
    forwarded,
    setCheckpoint: (read: typeof checkpoint) => {
      checkpoint = read;
    },
    onRun: (hook: () => Promise<void>) => {
      onRun = hook;
    },
    loseNextReply: () => {
      loseReply = true;
    },
    onIssue: (hook: () => Promise<void>) => {
      onIssue = hook;
    },
    setIssueFailure: (failure: typeof issueFailure) => {
      issueFailure = failure;
    },
    issued: () => issued,
    runCalls: () => runCalls,
    physicalCount: () => vms.size + tasks.size,
    stopped: () =>
      [...vms.values()].every(vm => vm.state === 'TERMINATED') &&
      [...tasks.values()].every(task => task.lastStatus === 'STOPPED'),
    launch() {
      const bytes = [...objects.entries()].find(([key]) => key.startsWith('kilo/launch/'))?.[1]
        .bytes;
      if (!bytes) throw new Error('Test launch document unavailable');
      const document = JSON.parse(new TextDecoder().decode(bytes)) as {
        env: Record<string, string>;
        argv: string[];
      };
      const runner = environmentBuildRunnerSchema.parse(
        JSON.parse(document.env.KILO_BUILDER_RUNNER ?? 'null')
      );
      const proxyCredential = new URL(document.env.HTTPS_PROXY ?? '').password;
      return {
        document,
        runner,
        proof: { credential: proxyCredential, identity: identity.secret },
      };
    },
    broker: {
      async redeemGitHubSessionCapability(input: unknown) {
        redemptions.push(input);
        return { success: true as const, authorization: 'Bearer synthetic-upstream-token' };
      },
      async issueGitHubSessionCapability(input: unknown) {
        brokerCalls.push(input);
        issued++;
        issueStarted.resolve();
        await onIssue();
        if (issueFailure) return issueFailure;
        return {
          success: true as const,
          capability: `kgh2.synthetic-build-${issued}`,
          source: 'installation' as const,
          installationId: '123',
          appType: 'standard' as const,
        };
      },
    },
  };
}
