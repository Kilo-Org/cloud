import { z } from 'zod';
import { awsEcsByocConfigurationSchema, awsEcsTaskArnSchema } from '@kilocode/worker-utils/aws-ecs';
import { ecsRunRequestSchema } from '../agent-sandbox/aws/ecs-client.js';
import type { AwsComputeStorage } from './aws-compute-lifecycle.js';

const refSchema = z
  .object({
    provider: z.literal('aws-ecs'),
    sandboxId: z.string().min(1).max(256),
    intentId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();
export type AwsEcsProviderRef = z.infer<typeof refSchema>;
export function encodeAwsEcsProviderRef(ref: AwsEcsProviderRef): string {
  return JSON.stringify(refSchema.parse(ref));
}
export function decodeAwsEcsProviderRef(raw: string | null): AwsEcsProviderRef | null {
  if (raw === null) return null;
  try {
    return refSchema.safeParse(JSON.parse(raw)).data ?? null;
  } catch {
    return null;
  }
}
export const awsEcsOperationSchema = z
  .object({
    ref: refSchema,
    config: awsEcsByocConfigurationSchema,
    phase: z.enum(['created', 'launching', 'running', 'stopping', 'terminated']),
    request: ecsRunRequestSchema.optional(),
    requestAt: z.number().int().nonnegative().optional(),
    submission: z.enum(['prepared', 'pending', 'uncertain']).optional(),
    deadlineAt: z.number().int().nonnegative().optional(),
    startSource: z.literal('repository').optional(),
    taskArn: awsEcsTaskArnSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const { request, config } = value;
    if (request && value.deadlineAt === undefined)
      context.addIssue({
        code: 'custom',
        path: ['deadlineAt'],
        message: 'A request must store its proxy credential deadline',
      });
    if (
      request &&
      (request.cluster !== config.clusterArn ||
        request.taskDefinition !== config.taskDefinitionArn ||
        request.capacityProviderStrategy[0].capacityProvider !== config.capacityProvider ||
        request.networkConfiguration.awsvpcConfiguration.subnets[0] !== config.subnetId ||
        request.networkConfiguration.awsvpcConfiguration.securityGroups[0] !==
          config.securityGroupId)
    )
      context.addIssue({
        code: 'custom',
        path: ['request'],
        message: 'Request must use the pinned ECS configuration',
      });
  });
export type AwsEcsOperation = z.infer<typeof awsEcsOperationSchema>;
export type AwsEcsOperationStorage = AwsComputeStorage<AwsEcsOperation>;
