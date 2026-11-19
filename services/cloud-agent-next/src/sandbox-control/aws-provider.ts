import { AwsMicrovmRunRejectedError } from '../agent-sandbox/aws/microvm-client.js';
import { ProviderLifecycleError } from './provider-failure.js';
import {
  AWS_MICROVM_MAXIMUM_DURATION_SECONDS,
  type AwsByocConfiguration,
} from '@kilocode/worker-utils/aws-byoc';
import type { MicrovmClient, MicrovmRunRequest } from '../agent-sandbox/aws/microvm-client.js';
import type { AwsObjectStore } from '../agent-sandbox/aws/object-store.js';
import { type ProviderStartup } from './provider.js';
import {
  decodeAwsProviderRef,
  encodeAwsProviderRef,
  awsOperationSchema,
  type AwsOperation,
  type AwsOperationStorage,
  type AwsProviderRef,
} from './aws-operation.js';
import {
  createAwsComputeLifecycle,
  type AwsComputeAdapter,
  type AwsPrepareSnapshot,
} from './aws-compute-lifecycle.js';
export type AwsProviderAdapter = AwsComputeAdapter;
export type AwsRuntimeAccess = {
  config: AwsByocConfiguration;
  client: MicrovmClient;
  objects: AwsObjectStore;
};

export function createAwsProviderAdapter(deps: {
  sandboxId: string;
  resolveRuntime: (configuration?: AwsByocConfiguration) => Promise<AwsRuntimeAccess>;
  storage: AwsOperationStorage;
  prepareStartup: (input: {
    startup: ProviderStartup;
    ref: AwsProviderRef;
    configuration: AwsByocConfiguration;
  }) => Promise<ProviderStartup>;
  prepareSnapshot?: AwsPrepareSnapshot<AwsByocConfiguration, AwsProviderRef>;
  now?: () => number;
}): AwsProviderAdapter {
  const now = deps.now ?? Date.now;
  return createAwsComputeLifecycle<
    AwsByocConfiguration,
    AwsProviderRef,
    MicrovmRunRequest,
    AwsOperation
  >({
    ...deps,
    codec: {
      read(raw) {
        const { microvmId, ...value } = awsOperationSchema.parse(raw);
        return { ...value, ...(microvmId ? { physicalId: microvmId } : {}) };
      },
      write({ physicalId, ...value }) {
        return awsOperationSchema.parse({
          ...value,
          ...(physicalId ? { microvmId: physicalId } : {}),
        });
      },
      encodeRef: encodeAwsProviderRef,
      decodeRef: decodeAwsProviderRef,
      newRef: intent => ({
        provider: 'aws',
        sandboxId: deps.sandboxId,
        intentId: intent.intentId,
        createdAt: intent.createdAt,
      }),
    },
    resolveConfiguration: async () => (await deps.resolveRuntime()).config,
    objects: async config => (await deps.resolveRuntime(config)).objects,
    describeRuntime(raw) {
      const ref = decodeAwsProviderRef(raw);
      return ref?.sandboxId === deps.sandboxId
        ? {
            provider: 'aws',
            sandboxId: deps.sandboxId,
            instanceId: ref.intentId,
            region: 'us-east-1',
            instanceType: 'microvm-8g',
          }
        : undefined;
    },
    engine: {
      async prepare(config, ref, envelope) {
        return {
          deadlineAt: now() + AWS_MICROVM_MAXIMUM_DURATION_SECONDS * 1000 - 120_000,
          request: {
            clientToken: ref.intentId,
            imageIdentifier: config.imageIdentifier,
            imageVersion: config.imageVersion,
            ingressNetworkConnectors: [
              `arn:aws:lambda:${config.region}:aws:network-connector:aws-network-connector:NO_INGRESS`,
            ],
            egressNetworkConnectors: [config.connectorArn],
            logging: { disabled: {} },
            maximumDurationInSeconds: AWS_MICROVM_MAXIMUM_DURATION_SECONDS,
            runHookPayload: JSON.stringify(envelope),
          },
        };
      },
      async runner(config) {
        const { client } = await deps.resolveRuntime(config);
        return async request => (await client.run(request)).microvmId;
      },
      isDefiniteRunRejection: error => error instanceof AwsMicrovmRunRejectedError,
      async inspect(value) {
        if (!value.physicalId) throw new Error('AWS launch identity is unresolved');
        const vm = await (await deps.resolveRuntime(value.config)).client.get(value.physicalId);
        const request = value.request;
        if (
          !request ||
          vm.imageArn !== request.imageIdentifier ||
          vm.imageVersion !== request.imageVersion ||
          JSON.stringify(vm.ingressNetworkConnectors) !==
            JSON.stringify(request.ingressNetworkConnectors) ||
          JSON.stringify(vm.egressNetworkConnectors) !==
            JSON.stringify(request.egressNetworkConnectors) ||
          vm.executionRoleArn != null ||
          vm.idlePolicy != null ||
          vm.maximumDurationInSeconds !== request.maximumDurationInSeconds
        )
          throw new ProviderLifecycleError('provider_identity_mismatch');
        return vm.state === 'TERMINATED'
          ? 'terminal'
          : vm.state === 'TERMINATING'
            ? 'stopping'
            : 'active';
      },
      async stop(config, id) {
        const { client } = await deps.resolveRuntime(config);
        await client.terminate(id);
        return (await client.get(id)).state === 'TERMINATED' ? 'terminal' : 'retryable';
      },
    },
  });
}
