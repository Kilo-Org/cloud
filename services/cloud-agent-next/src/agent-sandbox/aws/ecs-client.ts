import { z } from 'zod';
import {
  createAwsClient,
  readAwsResponse,
  AwsRequestError,
  type AwsCredentials,
  type AwsFetch,
} from '@kilocode/worker-utils/aws-client';
import {
  awsEcsByocConfigurationSchema,
  awsEcsTaskArnSchema,
  type AwsEcsByocConfiguration,
} from '@kilocode/worker-utils/aws-ecs';

const fields = awsEcsByocConfigurationSchema.shape;
const command = z
  .array(
    z
      .string()
      .max(8192)
      .refine(value => !value.includes('\0'))
  )
  .min(1)
  .max(64);
const bootstrapEnvironment = z
  .array(
    z
      .object({
        name: z.enum(['HTTP_PROXY', 'HTTPS_PROXY', 'NODE_USE_ENV_PROXY', 'NO_PROXY']),
        value: z
          .string()
          .max(4096)
          .refine(value => !value.includes('\0')),
      })
      .strict()
  )
  .max(4)
  .refine(entries => new Set(entries.map(entry => entry.name)).size === entries.length);
export const ecsRunRequestSchema = z
  .object({
    cluster: fields.clusterArn,
    taskDefinition: fields.taskDefinitionArn,
    capacityProviderStrategy: z.tuple([
      z.object({ capacityProvider: fields.capacityProvider, weight: z.literal(1) }).strict(),
    ]),
    count: z.literal(1),
    clientToken: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    startedBy: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    networkConfiguration: z
      .object({
        awsvpcConfiguration: z
          .object({
            subnets: z.tuple([fields.subnetId]),
            securityGroups: z.tuple([fields.securityGroupId]),
            assignPublicIp: z.literal('DISABLED'),
          })
          .strict(),
      })
      .strict(),
    overrides: z
      .object({
        containerOverrides: z.tuple([
          z
            .object({ name: z.literal('sandbox'), command, environment: bootstrapEnvironment })
            .strict(),
        ]),
      })
      .strict()
      .refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 8192),
    enableExecuteCommand: z.literal(false),
  })
  .strict();
export type EcsRunRequest = z.infer<typeof ecsRunRequestSchema>;
const state = z.enum([
  'PROVISIONING',
  'PENDING',
  'ACTIVATING',
  'RUNNING',
  'DEACTIVATING',
  'STOPPING',
  'DEPROVISIONING',
  'STOPPED',
  'DELETED',
]);
const taskSchema = z.object({
  taskArn: awsEcsTaskArnSchema,
  startedBy: z.string().optional(),
  clusterArn: fields.clusterArn,
  taskDefinitionArn: fields.taskDefinitionArn,
  capacityProviderName: fields.capacityProvider.optional(),
  trustedExecutionSummary: z.object({ isolationMode: z.string() }).optional(),
  lastStatus: state,
  enableExecuteCommand: z.boolean().optional(),
  overrides: z
    .object({ taskRoleArn: z.string().optional(), executionRoleArn: z.string().optional() })
    .optional(),
  attachments: z
    .array(
      z.object({
        type: z.string(),
        details: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
      })
    )
    .optional(),
  containers: z
    .array(z.object({ name: z.string(), exitCode: z.number().int().optional() }))
    .optional(),
});
export type EcsTask = z.infer<typeof taskSchema>;
const definitionSchema = z.object({
  taskDefinitionArn: fields.taskDefinitionArn,
  networkMode: z.string(),
  taskRoleArn: z.string().optional(),
  executionRoleArn: fields.executionRoleArn,
  cpu: z.string(),
  memory: z.string(),
  requiresCompatibilities: z.array(z.string()),
  runtimePlatform: z.object({ cpuArchitecture: z.string(), operatingSystemFamily: z.string() }),
  trustedExecutionConfiguration: z.object({ isolationMode: z.string() }),
  volumes: z.array(z.unknown()).optional(),
  containerDefinitions: z.array(
    z.object({
      name: z.string(),
      image: z.string(),
      essential: z.boolean().optional(),
      entryPoint: z.array(z.string()).optional(),
      privileged: z.boolean().optional(),
      environment: z.array(z.unknown()).optional(),
      secrets: z.array(z.unknown()).optional(),
      environmentFiles: z.array(z.unknown()).optional(),
      credentialSpecs: z.array(z.unknown()).optional(),
      mountPoints: z.array(z.unknown()).optional(),
      volumesFrom: z.array(z.unknown()).optional(),
    })
  ),
});
export type EcsTaskDefinition = z.infer<typeof definitionSchema>;

export function assertEcsTaskDefinition(
  definition: EcsTaskDefinition,
  config: AwsEcsByocConfiguration
): void {
  const container = definition.containerDefinitions[0];
  if (
    definition.taskDefinitionArn !== config.taskDefinitionArn ||
    definition.networkMode !== 'awsvpc' ||
    definition.taskRoleArn ||
    definition.executionRoleArn !== config.executionRoleArn ||
    definition.cpu !== '2048' ||
    definition.memory !== '8192' ||
    definition.requiresCompatibilities.length !== 1 ||
    definition.requiresCompatibilities[0] !== 'MANAGED_INSTANCES' ||
    definition.runtimePlatform.cpuArchitecture !== 'X86_64' ||
    definition.runtimePlatform.operatingSystemFamily !== 'LINUX' ||
    definition.trustedExecutionConfiguration.isolationMode !== 'ISOLATED_SANDBOX' ||
    (definition.volumes?.length ?? 0) !== 0 ||
    definition.containerDefinitions.length !== 1 ||
    !container ||
    container.name !== 'sandbox' ||
    container.image !== config.runtimeImage ||
    container.essential !== true ||
    container.privileged === true ||
    JSON.stringify(container.entryPoint) !== JSON.stringify(['/usr/local/bin/node']) ||
    (container.environment?.length ?? 0) !== 0 ||
    (container.secrets?.length ?? 0) !== 0 ||
    (container.environmentFiles?.length ?? 0) !== 0 ||
    (container.credentialSpecs?.length ?? 0) !== 0 ||
    (container.mountPoints?.length ?? 0) !== 0 ||
    (container.volumesFrom?.length ?? 0) !== 0
  ) {
    throw new AwsRequestError(0, 'TaskDefinitionMismatch');
  }
}
export function assertEcsTask(
  task: EcsTask,
  config: AwsEcsByocConfiguration,
  expectedArn: string
): void {
  const interfaces = (task.attachments ?? []).filter(
    attachment => attachment.type === 'ElasticNetworkInterface'
  );
  const subnet = interfaces[0]?.details?.find(detail => detail.name === 'subnetId')?.value;
  if (
    task.taskArn !== expectedArn ||
    task.clusterArn !== config.clusterArn ||
    task.taskDefinitionArn !== config.taskDefinitionArn ||
    (task.capacityProviderName !== undefined &&
      task.capacityProviderName !== config.capacityProvider) ||
    (task.lastStatus === 'RUNNING' && task.capacityProviderName !== config.capacityProvider) ||
    (task.trustedExecutionSummary !== undefined &&
      task.trustedExecutionSummary.isolationMode !== 'ISOLATED_SANDBOX') ||
    task.enableExecuteCommand === true ||
    task.overrides?.taskRoleArn ||
    (task.overrides?.executionRoleArn !== undefined &&
      task.overrides.executionRoleArn !== config.executionRoleArn) ||
    (['RUNNING', 'ACTIVATING'].includes(task.lastStatus) &&
      (interfaces.length !== 1 || subnet !== config.subnetId))
  ) {
    throw new AwsRequestError(0, 'TaskIdentityMismatch');
  }
}

/** Only explicit RunTask authorization/parameter refusals prove a first request made no task. */
export class AwsEcsRunRejectedError extends AwsRequestError {}

/** Signed ECS transport. Only normalized fields leave this boundary; AWS diagnostics and override secrets are discarded. */
export function createEcsClient(input: {
  credentials: AwsCredentials;
  region: string;
  fetch?: AwsFetch;
}) {
  const client = createAwsClient({ ...input, service: 'ecs' });
  async function request<T>(
    action: string,
    body: object,
    schema: z.ZodType<T>,
    signal?: AbortSignal
  ): Promise<T> {
    const response = await client.request(`https://ecs.${input.region}.amazonaws.com/`, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': `AmazonEC2ContainerServiceV20141113.${action}`,
      },
      body: JSON.stringify(body),
    });
    try {
      return schema.parse(JSON.parse(await readAwsResponse(response, 1024 * 1024)));
    } catch (error) {
      if (error instanceof AwsRequestError) throw error;
      throw new AwsRequestError(0, 'InvalidEcsResponse');
    }
  }
  return {
    async run(value: EcsRunRequest, signal?: AbortSignal): Promise<{ taskArn: string }> {
      const requestValue = ecsRunRequestSchema.parse(value);
      const result = await request(
        'RunTask',
        requestValue,
        z.object({
          tasks: z.array(z.object({ taskArn: awsEcsTaskArnSchema })),
          failures: z.array(z.unknown()).optional(),
        }),
        signal
      ).catch((error: unknown) => {
        if (
          error instanceof AwsRequestError &&
          (error.status === 403 ||
            (error.status === 400 &&
              ['AccessDeniedException', 'InvalidParameterException'].includes(error.code)))
        )
          throw new AwsEcsRunRejectedError(error.status, error.code);
        throw error;
      });
      if (result.tasks.length !== 1) throw new AwsRequestError(503, 'TaskLaunchRejected');
      // Preserve the physical identity before validating mutable task metadata, so failed admission can still stop it.
      return result.tasks[0];
    },
    /** Lists tasks whose desired status is RUNNING. ECS omits stopped tasks from this lookup. */
    async findByStartedBy(cluster: string, startedBy: string): Promise<string[] | undefined> {
      const result = await request(
        'ListTasks',
        {
          cluster: fields.clusterArn.parse(cluster),
          startedBy: ecsRunRequestSchema.shape.startedBy.parse(startedBy),
          maxResults: 2,
        },
        z.object({ taskArns: z.array(awsEcsTaskArnSchema).max(2), nextToken: z.string().nullish() })
      );
      // A partial page cannot establish the task set.
      return result.nextToken ? undefined : result.taskArns;
    },
    async get(
      cluster: string,
      taskArn: string,
      signal?: AbortSignal
    ): Promise<EcsTask | undefined> {
      const result = await request(
        'DescribeTasks',
        { cluster: fields.clusterArn.parse(cluster), tasks: [awsEcsTaskArnSchema.parse(taskArn)] },
        z.object({
          tasks: z.array(taskSchema),
          failures: z
            .array(z.object({ arn: z.string().optional(), reason: z.string() }))
            .optional(),
        }),
        signal
      );
      if (
        result.tasks.length === 0 &&
        result.failures?.length === 1 &&
        result.failures[0].reason === 'MISSING' &&
        result.failures[0].arn === taskArn
      )
        return undefined;
      if ((result.failures?.length ?? 0) !== 0 || result.tasks.length !== 1)
        throw new AwsRequestError(0, 'InvalidEcsResponse');
      return result.tasks[0];
    },
    async stop(cluster: string, taskArn: string, signal?: AbortSignal): Promise<void> {
      const result = await request(
        'StopTask',
        {
          cluster: fields.clusterArn.parse(cluster),
          task: awsEcsTaskArnSchema.parse(taskArn),
          reason: 'Kilo sandbox allocation stopped',
        },
        z.object({ task: z.object({ taskArn: awsEcsTaskArnSchema }) }),
        signal
      );
      if (result.task.taskArn !== taskArn) throw new AwsRequestError(0, 'InvalidEcsResponse');
    },
    async definition(taskDefinition: string, signal?: AbortSignal): Promise<EcsTaskDefinition> {
      const result = await request(
        'DescribeTaskDefinition',
        { taskDefinition: fields.taskDefinitionArn.parse(taskDefinition) },
        z.object({ taskDefinition: definitionSchema }),
        signal
      );
      return result.taskDefinition;
    },
  };
}
export type EcsClient = ReturnType<typeof createEcsClient>;
