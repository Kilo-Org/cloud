import { z } from 'zod';
import { microvmRunRequestSchema } from '../agent-sandbox/aws/microvm-client.js';
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
    // Missing on legacy records, whose submission outcome must remain uncertain.
    submission: z.enum(['prepared', 'pending', 'uncertain']).optional(),
    microvmId: z
      .string()
      .regex(/^microvm-[a-z0-9-]+$/)
      .optional(),
    deadlineAt: z.number().int().nonnegative().optional(),
  })
  .strict();

export type AwsOperation = z.infer<typeof awsOperationSchema>;

/** The owning Sandbox DO supplies its existing durable KV storage. */
export type AwsOperationStorage = {
  get(id: string): Promise<unknown>;
  update(id: string, transition: (value: unknown) => AwsOperation): Promise<AwsOperation>;
  list(): Promise<Map<string, unknown>>;
  delete(id: string): Promise<void>;
};

/** Bound retained history. Unconfirmed operations are never removed to make space. */
export async function reserveAwsOperation(
  storage: AwsOperationStorage,
  operation: AwsOperation
): Promise<AwsOperation> {
  const entries = await storage.list();
  if (entries.has(operation.ref.intentId))
    return awsOperationSchema.parse(entries.get(operation.ref.intentId));
  const completed = [...entries].filter(
    ([, value]) => awsOperationSchema.safeParse(value).data?.phase === 'terminated'
  );
  for (const [id] of completed) {
    if (entries.size < 32) break;
    await storage.delete(id);
    entries.delete(id);
  }
  if (entries.size >= 32) throw new Error('AWS allocation cleanup requires attention');
  return storage.update(operation.ref.intentId, current => {
    if (current !== undefined) return awsOperationSchema.parse(current);
    return operation;
  });
}
