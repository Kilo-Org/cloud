import type { ProviderStartup } from '../../src/sandbox-control/provider.js';
import { z } from 'zod';
import { awsEcsByocConfigurationSchema } from '@kilocode/worker-utils/aws-ecs';
import { AwsRequestError } from '@kilocode/worker-utils/aws-client';
import {
  createEcsClient,
  ecsRunRequestSchema,
  type EcsTask,
  type EcsTaskDefinition,
  type EcsRunRequest,
} from '../../src/agent-sandbox/aws/ecs-client.js';
import type { AwsObjectStore } from '../../src/agent-sandbox/aws/object-store.js';
import { createAwsEcsProviderAdapter } from '../../src/sandbox-control/aws-ecs-provider.js';
import {
  awsEcsOperationSchema,
  type AwsEcsOperation,
  type AwsEcsOperationStorage,
} from '../../src/sandbox-control/aws-ecs-operation.js';

export const ECS_TEST_CONFIG = awsEcsByocConfigurationSchema.parse({
  region: 'us-east-1',
  roleArn: 'arn:aws:iam::123456789012:role/customer',
  externalId: 'a'.repeat(64),
  stackId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/customer/12345678-abcd',
  bucket: 'customer-artifacts',
  templateVersion: 1,
  proxyProtocolVersion: 1,
  proxy: {
    generation: '22222222-2222-4222-8222-222222222222',
    hostname: 'proxy.internal.example.com',
    caFingerprint: 'b'.repeat(64),
  },
  clusterArn: 'arn:aws:ecs:us-east-1:123456789012:cluster/customer',
  taskDefinitionArn: 'arn:aws:ecs:us-east-1:123456789012:task-definition/customer:1',
  capacityProvider: 'customer-managed',
  subnetId: 'subnet-0123456789abcdef0',
  securityGroupId: 'sg-0123456789abcdef0',
  executionRoleArn: 'arn:aws:iam::123456789012:role/execution',
  runtimeImage: `999999999999.dkr.ecr.us-east-1.amazonaws.com/runtime@sha256:${'c'.repeat(64)}`,
});
export function ecsDefinition(): EcsTaskDefinition {
  return {
    taskDefinitionArn: ECS_TEST_CONFIG.taskDefinitionArn,
    networkMode: 'awsvpc',
    executionRoleArn: ECS_TEST_CONFIG.executionRoleArn,
    cpu: '2048',
    memory: '8192',
    requiresCompatibilities: ['MANAGED_INSTANCES'],
    runtimePlatform: { cpuArchitecture: 'X86_64', operatingSystemFamily: 'LINUX' },
    trustedExecutionConfiguration: { isolationMode: 'ISOLATED_SANDBOX' },
    containerDefinitions: [
      {
        name: 'sandbox',
        image: ECS_TEST_CONFIG.runtimeImage,
        essential: true,
        entryPoint: ['/usr/local/bin/node'],
      },
    ],
  };
}
export function ecsTask(): EcsTask {
  return {
    taskArn: `arn:aws:ecs:us-east-1:123456789012:task/customer/${'d'.repeat(32)}`,
    clusterArn: ECS_TEST_CONFIG.clusterArn,
    taskDefinitionArn: ECS_TEST_CONFIG.taskDefinitionArn,
    capacityProviderName: ECS_TEST_CONFIG.capacityProvider,
    lastStatus: 'RUNNING',
    enableExecuteCommand: false,
    trustedExecutionSummary: { isolationMode: 'ISOLATED_SANDBOX' },
    attachments: [
      {
        type: 'ElasticNetworkInterface',
        details: [{ name: 'subnetId', value: ECS_TEST_CONFIG.subnetId }],
      },
    ],
  };
}
export const ECS_TEST_CREDENTIALS = {
  accessKeyId: 'ASIATEST000000000000',
  secretAccessKey: 'test-secret',
  sessionToken: 'test-token',
};

/** Transport fake retains requests, documents and physical task effects across adapter restarts. */
export function ecsProviderFixture(sandboxId = 'ses-abcdef') {
  const operations = new Map<string, AwsEcsOperation>();
  const documents = new Map<string, string>();
  const submitted: EcsRunRequest[] = [];
  const discoveries: unknown[] = [];
  let discoveryResult: { taskArns: string[]; nextToken?: string } | undefined;
  const tasks = new Map<string, EcsTask>();
  const requests = new Map<string, string>();
  const runStarted = Promise.withResolvers<void>();
  const putStarted = Promise.withResolvers<void>();
  let now = 10_000;
  let prepareSnapshot: Parameters<typeof createAwsEcsProviderAdapter>[0]['prepareSnapshot'];
  let loseReply = false;
  let runRejection: { status: number; code: string } | undefined;
  let deleteError = false;
  let missing = false;
  let observeError = false;
  let stopError = false;
  let runtimeError: Error | undefined;
  let runGate: Promise<void> | undefined;
  let putGate: Promise<void> | undefined;
  let definition = ecsDefinition();
  let taskPatch: Partial<EcsTask> = {};
  let signedUrls = 0;
  const storage: AwsEcsOperationStorage = {
    get: async id => structuredClone(operations.get(id)),
    async update(id, transition) {
      const next = transition(structuredClone(operations.get(id)));
      operations.set(id, structuredClone(next));
      return structuredClone(next);
    },
    list: async () => structuredClone(operations),
    delete: async id => {
      operations.delete(id);
    },
  };
  let operationStorage = storage;
  const client = createEcsClient({
    credentials: ECS_TEST_CREDENTIALS,
    region: 'us-east-1',
    fetch: async request => {
      const body = await request.json();
      switch (request.headers.get('x-amz-target')?.split('.').at(-1)) {
        case 'DescribeTaskDefinition':
          return Response.json({ taskDefinition: definition });
        case 'RunTask': {
          const launch = ecsRunRequestSchema.parse(body);
          if (
            JSON.stringify(
              [...(await operationStorage.list()).values()]
                .map(value => awsEcsOperationSchema.parse(value))
                .find(value => value.request?.clientToken === launch.clientToken)?.request
            ) !== JSON.stringify(body)
          )
            throw new Error('Run preceded exact request checkpoint');
          submitted.push(launch);
          if (runRejection) {
            const rejection = runRejection;
            runRejection = undefined;
            runStarted.resolve();
            if (runGate) await runGate;
            return Response.json(
              { __type: rejection.code },
              { status: rejection.status, headers: { 'x-amzn-errortype': rejection.code } }
            );
          }
          if (
            requests.has(launch.clientToken) &&
            requests.get(launch.clientToken) !== JSON.stringify(body)
          )
            return new Response(null, { status: 409 });
          requests.set(launch.clientToken, JSON.stringify(body));
          let task = tasks.get(launch.clientToken);
          if (!task) {
            task = {
              ...ecsTask(),
              startedBy: launch.startedBy,
              taskArn: ecsTask().taskArn.replace(
                'd'.repeat(32),
                (tasks.size + 1).toString(16).padStart(32, '0')
              ),
              ...taskPatch,
            };
            tasks.set(launch.clientToken, task);
          }
          runStarted.resolve();
          if (runGate) await runGate;
          if (loseReply) {
            loseReply = false;
            throw new Error('lost reply');
          }
          return Response.json({ tasks: [task], failures: [] });
        }
        case 'ListTasks': {
          const lookup = z
            .object({ cluster: z.string(), startedBy: z.string(), maxResults: z.literal(2) })
            .strict()
            .parse(body);
          discoveries.push(lookup);
          return Response.json(
            discoveryResult ?? {
              taskArns: [...tasks.values()]
                .filter(
                  task => task.clusterArn === lookup.cluster && task.startedBy === lookup.startedBy
                )
                .map(task => task.taskArn),
            }
          );
        }
        case 'DescribeTasks': {
          if (observeError) return new Response(null, { status: 503 });
          const lookup = z.object({ tasks: z.array(z.string()) }).parse(body);
          const task = [...tasks.values()].find(value => value.taskArn === lookup.tasks[0]);
          return Response.json(
            !task || missing
              ? { tasks: [], failures: [{ arn: lookup.tasks[0], reason: 'MISSING' }] }
              : { tasks: [task], failures: [] }
          );
        }
        case 'StopTask': {
          if (stopError) return new Response(null, { status: 503 });
          const stop = z.object({ task: z.string() }).parse(body);
          const task = [...tasks.values()].find(value => value.taskArn === stop.task);
          if (!task) return new Response(null, { status: 404 });
          task.lastStatus = 'STOPPED';
          return Response.json({ task });
        }
        default:
          throw new Error('Unexpected ECS action');
      }
    },
  });
  const objects: AwsObjectStore = {
    async putLaunch(key, value) {
      putStarted.resolve();
      if (putGate) await putGate;
      if (documents.has(key)) throw new AwsRequestError(412, 'PreconditionFailed');
      documents.set(key, value);
    },
    async deleteLaunch(key) {
      if (deleteError) throw new AwsRequestError(503, 'ServiceUnavailableException');
      documents.delete(key);
    },
    async downloadUrl(key) {
      signedUrls++;
      return `https://customer-artifacts.s3.us-east-1.amazonaws.com/${key}?test=${signedUrls}`;
    },
    prepareArchiveUpload: async () => {
      throw new Error('Unexpected archive upload');
    },
    inspectArchive: async () => null,
    deleteArchive: async () => {},
  };
  return {
    setSnapshotPreparation(hook: (startup: ProviderStartup) => Promise<ProviderStartup>) {
      prepareSnapshot = ({ startup }) => hook(startup);
    },
    discoveries,
    setDiscoveryResult: (result: { taskArns: string[]; nextToken?: string }) => {
      discoveryResult = result;
    },
    operations,
    documents,
    submitted,
    tasks,
    runStarted: runStarted.promise,
    putStarted: putStarted.promise,
    adapter: (override: AwsEcsOperationStorage = storage) => {
      operationStorage = override;
      return createAwsEcsProviderAdapter({
        sandboxId,
        storage: override,
        now: () => now,
        resolveRuntime: async (config = ECS_TEST_CONFIG) => {
          if (runtimeError) throw runtimeError;
          return { config, client, objects };
        },
        prepareSnapshot,
        prepareStartup: async ({ startup }) => startup,
      });
    },
    rejectNextRun: (status: number, code: string) => {
      runRejection = { status, code };
    },
    failDelete: (fail: boolean) => {
      deleteError = fail;
    },
    loseNextReply: () => {
      loseReply = true;
    },
    setNow: (value: number) => {
      now = value;
    },
    setMissing: (value: boolean) => {
      missing = value;
    },
    gateRun: (value?: Promise<void>) => {
      runGate = value;
    },
    gatePut: (value: Promise<void>) => {
      putGate = value;
    },
    setDefinition: (value: EcsTaskDefinition) => {
      definition = value;
    },
    setTaskPatch: (value: Partial<EcsTask>) => {
      taskPatch = value;
      for (const task of tasks.values()) Object.assign(task, value);
    },
    signedUrls: () => signedUrls,
    failObserve: () => {
      observeError = true;
    },
    failStop: () => {
      stopError = true;
    },
    failRuntime: (error: Error) => {
      runtimeError = error;
    },
    setRunning: (running: boolean) => {
      for (const task of tasks.values()) task.lastStatus = running ? 'RUNNING' : 'STOPPED';
    },
    launchedDocument: () => {
      const document = [...documents.values()].at(-1);
      if (!document) throw new Error('Launch document unavailable');
      return z
        .object({ argv: z.array(z.string()), env: z.record(z.string(), z.string()) })
        .parse(JSON.parse(document));
    },
  };
}
