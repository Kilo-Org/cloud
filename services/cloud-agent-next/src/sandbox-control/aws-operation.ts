import { z } from 'zod';
import { microvmRunRequestSchema } from '../agent-sandbox/aws/microvm-client.js';
import type { AwsComputeStorage } from './aws-compute-lifecycle.js';
import { awsByocConfigurationSchema } from '@kilocode/worker-utils/aws-byoc';

const awsProviderRefSchema = z
  .object({
    provider: z.literal('aws'),
    sandboxId: z.string().min(1).max(256),
    intentId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();

export type AwsProviderRef = z.infer<typeof awsProviderRefSchema>;

export function encodeAwsProviderRef(ref: AwsProviderRef): string {
  return JSON.stringify(awsProviderRefSchema.parse(ref));
}

export function decodeAwsProviderRef(raw: string | null): AwsProviderRef | null {
  if (raw === null) return null;
  try {
    const parsed = awsProviderRefSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const awsOperationSchema = z
  .object({
    ref: awsProviderRefSchema,
    config: awsByocConfigurationSchema,
    phase: z.enum(['created', 'launching', 'running', 'stopping', 'terminated']),
    request: microvmRunRequestSchema.optional(),
    requestAt: z.number().int().nonnegative().optional(),
    submission: z.enum(['prepared', 'pending', 'uncertain']).optional(),
    startSource: z.literal('repository').optional(),
    microvmId: z
      .string()
      .regex(/^microvm-[a-z0-9-]+$/)
      .optional(),
    deadlineAt: z.number().int().nonnegative().optional(),
  })
  .strict();

export type AwsOperation = z.infer<typeof awsOperationSchema>;

/** The existing persisted shape and storage prefix remain unchanged. */
export type AwsOperationStorage = AwsComputeStorage<AwsOperation>;
