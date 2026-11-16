import type { AwsEcsByocConfiguration } from '@kilocode/worker-utils/aws-ecs';
import jwt from 'jsonwebtoken';
import { AwsRequestError } from '@kilocode/worker-utils/aws-client';
import { awsEgressClaimsSchema } from '@kilocode/worker-utils/aws-egress';
import { sha256Hex } from '@kilocode/worker-utils/sha256';
import {
  AwsEcsRunRejectedError,
  assertEcsTask,
  assertEcsTaskDefinition,
  ecsRunRequestSchema,
  type EcsClient,
  type EcsRunRequest,
} from '../agent-sandbox/aws/ecs-client.js';
import type { AwsObjectStore } from '../agent-sandbox/aws/object-store.js';
import {
  createAwsComputeLifecycle,
  type AwsComputeAdapter,
  type AwsPrepareSnapshot,
} from './aws-compute-lifecycle.js';
import {
  awsEcsOperationSchema,
  decodeAwsEcsProviderRef,
  encodeAwsEcsProviderRef,
  type AwsEcsOperation,
  type AwsEcsOperationStorage,
  type AwsEcsProviderRef,
} from './aws-ecs-operation.js';
import type { ProviderStartup } from './provider.js';

export type AwsEcsRuntimeAccess = {
  config: AwsEcsByocConfiguration;
  client: EcsClient;
  objects: AwsObjectStore;
};

/** ECS supplies its API and isolation checks to the shared AWS allocation lifecycle. */
export function createAwsEcsProviderAdapter(deps: {
  sandboxId: string;
  storage: AwsEcsOperationStorage;
  resolveRuntime(configuration?: AwsEcsByocConfiguration): Promise<AwsEcsRuntimeAccess>;
  prepareStartup(input: {
    startup: ProviderStartup;
    ref: AwsEcsProviderRef;
    configuration: AwsEcsByocConfiguration;
  }): Promise<ProviderStartup>;
  prepareSnapshot?: AwsPrepareSnapshot<AwsEcsByocConfiguration, AwsEcsProviderRef>;
  now?: () => number;
}): AwsComputeAdapter {
  return createAwsComputeLifecycle<
    AwsEcsByocConfiguration,
    AwsEcsProviderRef,
    EcsRunRequest,
    AwsEcsOperation
  >({
    ...deps,
    codec: {
      read(raw) {
        const { taskArn, ...value } = awsEcsOperationSchema.parse(raw);
        return { ...value, ...(taskArn ? { physicalId: taskArn } : {}) };
      },
      write({ physicalId, ...value }) {
        return awsEcsOperationSchema.parse({
          ...value,
          ...(physicalId ? { taskArn: physicalId } : {}),
        });
      },
      encodeRef: encodeAwsEcsProviderRef,
      decodeRef: decodeAwsEcsProviderRef,
      newRef: intent => ({
        provider: 'aws-ecs',
        sandboxId: deps.sandboxId,
        intentId: intent.intentId,
        createdAt: intent.createdAt,
      }),
    },
    resolveConfiguration: async () => (await deps.resolveRuntime()).config,
    objects: async config => (await deps.resolveRuntime(config)).objects,
    describeRuntime(raw) {
      const ref = decodeAwsEcsProviderRef(raw);
      return ref?.sandboxId === deps.sandboxId
        ? {
            provider: 'aws-ecs',
            sandboxId: deps.sandboxId,
            instanceId: ref.intentId,
            region: 'us-east-1',
            instanceType: 'ecs-8g',
          }
        : undefined;
    },
    engine: {
      deadline(value) {
        if (!value.request) return undefined;
        // This server-owned checkpoint already contains the issued credential. Decoding its expiry
        // schedules cleanup; it never authenticates an incoming token or changes its authority.
        try {
          const proxy = value.request.overrides.containerOverrides[0].environment.find(
            field => field.name === 'HTTPS_PROXY'
          )?.value;
          const token = proxy ? decodeURIComponent(new URL(proxy).password) : '';
          const claims = awsEgressClaimsSchema.parse(jwt.decode(token));
          if (
            claims.sandboxId !== value.ref.sandboxId ||
            claims.allocationId !== value.ref.intentId ||
            claims.stackId !== value.config.stackId ||
            claims.generation !== value.config.proxy.generation
          )
            return { at: 0, reason: 'invalid_configuration' };
          return { at: claims.exp * 1000, reason: 'byoc_aws_proxy_expired' };
        } catch {
          return { at: 0, reason: 'invalid_configuration' };
        }
      },
      async prepare(config, ref, envelope) {
        const { client } = await deps.resolveRuntime(config);
        assertEcsTaskDefinition(await client.definition(config.taskDefinitionArn), config);
        const token = await sha256Hex(JSON.stringify([ref.sandboxId, ref.intentId]));
        return {
          request: ecsRunRequestSchema.parse({
            cluster: config.clusterArn,
            taskDefinition: config.taskDefinitionArn,
            capacityProviderStrategy: [{ capacityProvider: config.capacityProvider, weight: 1 }],
            count: 1,
            clientToken: token,
            startedBy: token,
            networkConfiguration: {
              awsvpcConfiguration: {
                subnets: [config.subnetId],
                securityGroups: [config.securityGroupId],
                assignPublicIp: 'DISABLED',
              },
            },
            overrides: {
              containerOverrides: [
                {
                  name: 'sandbox',
                  command: [
                    '--input-type=module',
                    '-e',
                    'import {startLaunchDocument} from "/opt/kilo/aws/launch-document.mjs";startLaunchDocument(JSON.parse(process.argv[1])).catch(()=>{console.error("AWS launch failed");process.exit(1)});',
                    JSON.stringify(envelope),
                  ],
                  environment: envelope.proxy
                    ? [
                        { name: 'HTTP_PROXY', value: envelope.proxy },
                        { name: 'HTTPS_PROXY', value: envelope.proxy },
                        { name: 'NODE_USE_ENV_PROXY', value: '1' },
                        { name: 'NO_PROXY', value: 'localhost,127.0.0.1,::1' },
                      ]
                    : [],
                },
              ],
            },
            enableExecuteCommand: false,
          }),
        };
      },
      async discover(value) {
        if (!value.request) return undefined;
        const { client } = await deps.resolveRuntime(value.config);
        const id = await client.findByStartedBy(value.config.clusterArn, value.request.startedBy);
        if (!id) return undefined;
        const task = await client.get(value.config.clusterArn, id);
        if (!task) return undefined;
        if (
          task.taskArn !== id ||
          task.clusterArn !== value.config.clusterArn ||
          task.startedBy !== value.request.startedBy ||
          !id.startsWith(value.config.clusterArn.replace(':cluster/', ':task/') + '/')
        )
          throw new AwsRequestError(0, 'TaskIdentityMismatch');
        // Persist immutable ownership before mutable admission checks so cleanup remains possible.
        return id;
      },
      async runner(config) {
        const { client } = await deps.resolveRuntime(config);
        return async request => (await client.run(request)).taskArn;
      },
      isDefiniteRunRejection: error => error instanceof AwsEcsRunRejectedError,
      async inspect(value) {
        if (!value.physicalId) throw new Error('AWS launch identity is unresolved');
        const task = await (
          await deps.resolveRuntime(value.config)
        ).client.get(value.config.clusterArn, value.physicalId);
        // ECS reads are eventually consistent. Missing is never termination evidence.
        if (!task) return 'unknown';
        assertEcsTask(task, value.config, value.physicalId);
        if (task.lastStatus === 'STOPPED' || task.lastStatus === 'DELETED') return 'terminal';
        if (['DEACTIVATING', 'STOPPING', 'DEPROVISIONING'].includes(task.lastStatus))
          return 'stopping';
        return task.lastStatus === 'RUNNING' ? 'active' : 'pending';
      },
      async stop(config, id) {
        const { client } = await deps.resolveRuntime(config);
        // Stop uses only the stored identity, even when runtime admission rejected its metadata.
        const before = await client.get(config.clusterArn, id);
        if (before?.lastStatus === 'STOPPED' || before?.lastStatus === 'DELETED') return 'terminal';
        await client.stop(config.clusterArn, id);
        const after = await client.get(config.clusterArn, id);
        return after?.lastStatus === 'STOPPED' || after?.lastStatus === 'DELETED'
          ? 'terminal'
          : 'retryable';
      },
    },
  });
}
