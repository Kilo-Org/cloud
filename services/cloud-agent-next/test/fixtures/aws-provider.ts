import type { ProviderStartup } from '../../src/sandbox-control/provider.js';
import { z } from 'zod';
import type { AwsByocConfiguration } from '@kilocode/worker-utils/aws-byoc';
import { AwsRequestError } from '@kilocode/worker-utils/aws-client';
import type {
  Microvm,
  MicrovmClient,
  MicrovmRunRequest,
} from '../../src/agent-sandbox/aws/microvm-client.js';
import type { AwsObjectStore } from '../../src/agent-sandbox/aws/object-store.js';
import { createAwsProviderAdapter } from '../../src/sandbox-control/aws-provider.js';
import type { AwsOperation, AwsOperationStorage } from '../../src/sandbox-control/aws-operation.js';

export const AWS_TEST_CONFIGURATION: AwsByocConfiguration = {
  region: 'us-east-1',
  roleArn: 'arn:aws:iam::123456789012:role/customer',
  externalId: 'external-id-000000000000000000000000000000',
  stackId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/customer/12345678-abcd',
  bucket: 'customer-artifacts',
  imageIdentifier: 'arn:aws:lambda:us-east-1:123456789012:microvm-image:kilo',
  imageVersion: '1.0',
  connectorArn: 'arn:aws:lambda:us-east-1:123456789012:network-connector:customer:1',
  templateVersion: 2,
  proxyProtocolVersion: 1,
};

export function awsProviderFixture(sandboxId = 'ses-abcdef') {
  const operations = new Map<string, AwsOperation>();
  const objects = new Map<string, string>();
  const submitted: MicrovmRunRequest[] = [];
  const runStarted = Promise.withResolvers<void>();
  const putStarted = Promise.withResolvers<void>();
  const vms = new Map<string, { request: MicrovmRunRequest; initial: Microvm; current: Microvm }>();
  let now = 10_000;
  let prepareSnapshot: Parameters<typeof createAwsProviderAdapter>[0]['prepareSnapshot'];
  let loseReply = false;
  let runError: Error | undefined;
  let inspectError = false;
  let stopError = false;
  let deleteError = false;
  let runtimeError: Error | undefined;
  let putGate: Promise<void> | undefined;
  let runGate: Promise<void> | undefined;
  let override: Partial<Microvm> = {};
  let signedUrls = 0;
  let runtimeReads = 0;
  const storage: AwsOperationStorage = {
    get: async id => structuredClone(operations.get(id)),
    async update(id, transition) {
      const next = transition(structuredClone(operations.get(id)));
      operations.set(id, structuredClone(next));
      return structuredClone(next);
    },
    list: async () => structuredClone(operations),
    async delete(id) {
      operations.delete(id);
    },
  };
  const client: MicrovmClient = {
    async run(request) {
      submitted.push(structuredClone(request));
      runStarted.resolve();
      if (runError) {
        const error = runError;
        runError = undefined;
        if (runGate) await runGate;
        throw error;
      }
      let vm = vms.get(request.clientToken);
      if (vm) {
        if (JSON.stringify(vm.request) !== JSON.stringify(request))
          throw new AwsRequestError(409, 'IdempotentParameterMismatch');
      } else {
        const initial: Microvm = {
          microvmId: 'microvm-' + (vms.size + 1),
          imageArn: request.imageIdentifier,
          imageVersion: request.imageVersion,
          state: 'PENDING',
          startedAt: now / 1000,
          maximumDurationInSeconds: request.maximumDurationInSeconds,
          ingressNetworkConnectors: request.ingressNetworkConnectors,
          egressNetworkConnectors: request.egressNetworkConnectors,
          executionRoleArn: null,
          idlePolicy: null,
        };
        vm = {
          request: structuredClone(request),
          initial,
          current: { ...initial, state: 'RUNNING', ...override },
        };
        vms.set(request.clientToken, vm);
      }
      if (runGate) await runGate;
      if (loseReply) {
        loseReply = false;
        throw new AwsRequestError(0, 'TransportError');
      }
      return structuredClone(vm.initial);
    },
    async get(id) {
      if (inspectError) throw new AwsRequestError(503, 'InternalServerException');
      const vm = [...vms.values()].find(vm => vm.current.microvmId === id);
      if (!vm) throw new AwsRequestError(404, 'ResourceNotFoundException');
      return structuredClone(vm.current);
    },
    async terminate(id) {
      if (stopError) throw new AwsRequestError(503, 'InternalServerException');
      const vm = [...vms.values()].find(vm => vm.current.microvmId === id);
      if (vm) vm.current.state = 'TERMINATED';
    },
  };
  const objectStore: AwsObjectStore = {
    prepareArchiveUpload: async () => {
      throw new Error('Archive uploads unavailable in lifecycle fixture');
    },
    inspectArchive: async () => null,
    async putLaunch(key, body) {
      putStarted.resolve();
      if (putGate) await putGate;
      if (objects.has(key)) throw new AwsRequestError(412, 'PreconditionFailed');
      objects.set(key, body);
    },
    async deleteLaunch(key) {
      if (deleteError) throw new AwsRequestError(503, 'InternalServerException');
      objects.delete(key);
    },
    async downloadUrl(key) {
      signedUrls++;
      return `https://customer-artifacts.s3.us-east-1.amazonaws.com/${key}?test-signature=${signedUrls}`;
    },
  };
  function adapter(operationStorage: AwsOperationStorage = storage) {
    return createAwsProviderAdapter({
      sandboxId,
      storage: operationStorage,
      prepareSnapshot,
      prepareStartup: async ({ startup }) => startup,
      now: () => now,
      async resolveRuntime(config = AWS_TEST_CONFIGURATION) {
        runtimeReads++;
        if (runtimeError) throw runtimeError;
        return { config, client, objects: objectStore };
      },
    });
  }
  return {
    setSnapshotPreparation(hook: (startup: ProviderStartup) => Promise<ProviderStartup>) {
      prepareSnapshot = ({ startup }) => hook(startup);
    },
    adapter,
    operations,
    objects,
    submitted,
    runStarted: runStarted.promise,
    putStarted: putStarted.promise,
    vms,
    storage,
    setNow(value: number) {
      now = value;
    },
    rejectNextRun(error: Error) {
      runError = error;
    },
    loseNextReply() {
      loseReply = true;
    },
    failObserve() {
      inspectError = true;
    },
    failDelete(value: boolean) {
      deleteError = value;
    },
    failStop() {
      stopError = true;
    },
    failRuntime(error: Error) {
      runtimeError = error;
    },
    setRunning(running: boolean) {
      for (const vm of vms.values()) vm.current.state = running ? 'RUNNING' : 'TERMINATED';
    },
    overrideResponse(value: Partial<Microvm>) {
      override = value;
    },
    gatePut(value: Promise<void> | undefined) {
      putGate = value;
    },
    gateRun(value: Promise<void> | undefined) {
      runGate = value;
    },
    signedUrls: () => signedUrls,
    runtimeReads: () => runtimeReads,
    launchedDocument() {
      const body = [...objects.values()].at(-1);
      if (!body) throw new Error('Launch document unavailable');
      return z
        .object({ argv: z.array(z.string()), env: z.record(z.string(), z.string()) })
        .parse(JSON.parse(body));
    },
  };
}
