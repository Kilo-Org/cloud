import { z } from 'zod';

const identifierSchema = z.string().min(1).max(256);
const intervalIdSchema = z.string().min(1).max(512);
const subjectIdSchema = z.string().min(1).max(256);
const serviceSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/);
const metadataSchema = z
  .record(z.string().min(1).max(64), z.string().max(512))
  .refine(
    metadata => Object.keys(metadata).length <= 16,
    'Metadata may contain at most 16 entries'
  );

export const billingSubjectSchema = z
  .object({
    type: z.enum(['user', 'org']),
    id: subjectIdSchema,
  })
  .strict();
export type BillingSubject = z.infer<typeof billingSubjectSchema>;

export const billingActorSchema = z
  .object({
    type: z.enum(['user', 'bot']),
    id: subjectIdSchema,
  })
  .strict();
export type BillingActor = z.infer<typeof billingActorSchema>;

const usageContextBaseSchema = z
  .object({
    service: serviceSchema,
    instanceId: identifierSchema,
    sku: z.string().min(1).max(128),
    subject: billingSubjectSchema,
    actor: billingActorSchema,
    onBehalfOf: billingSubjectSchema.optional(),
    sessionId: z.string().min(1).max(256).optional(),
    metadata: metadataSchema.optional(),
  })
  .strict();

function validateAttribution(
  context: z.infer<typeof usageContextBaseSchema>,
  refinement: z.RefinementCtx
): void {
  if (context.actor.type === 'bot') {
    if (
      !context.onBehalfOf ||
      context.onBehalfOf.type !== context.subject.type ||
      context.onBehalfOf.id !== context.subject.id
    ) {
      refinement.addIssue({
        code: 'custom',
        path: ['onBehalfOf'],
        message: 'Bot actors must act on behalf of the billing subject',
      });
    }
    return;
  }

  if (context.onBehalfOf) {
    refinement.addIssue({
      code: 'custom',
      path: ['onBehalfOf'],
      message: 'User actors cannot set onBehalfOf',
    });
  }
  if (context.subject.type === 'user' && context.actor.id !== context.subject.id) {
    refinement.addIssue({
      code: 'custom',
      path: ['actor', 'id'],
      message: 'Personal usage must be attributed to the same user actor',
    });
  }
}

export const usageContextSchema = usageContextBaseSchema.superRefine(validateAttribution);
export type UsageContext = z.infer<typeof usageContextSchema>;

const intervalIdentitySchema = z.object({
  service: serviceSchema,
  instanceId: identifierSchema,
  startEpochMs: z.number().int().nonnegative().finite(),
});

export const recordStartInputSchema = usageContextBaseSchema
  .extend({
    idempotencyKey: z.string().min(1).max(1_024),
    startEpochMs: z.number().int().nonnegative().finite(),
  })
  .strict()
  .superRefine(validateAttribution);
export type RecordStartInput = z.input<typeof recordStartInputSchema>;

export const recordHeartbeatInputSchema = intervalIdentitySchema
  .extend({
    idempotencyKey: z.string().min(1).max(1_024),
    seq: z.number().int().positive().max(2_147_483_647),
    usageSinceLast: z.number().int().nonnegative().max(2_147_483_647).optional(),
    context: usageContextSchema,
  })
  .strict();
export type RecordHeartbeatInput = z.input<typeof recordHeartbeatInputSchema>;

export const recordStopInputSchema = intervalIdentitySchema
  .extend({
    idempotencyKey: z.string().min(1).max(1_024),
    seq: z.number().int().positive().max(2_147_483_647),
    usageSinceLast: z.number().int().nonnegative().max(2_147_483_647),
    reason: z.enum(['exit', 'runtime_signal', 'activity_expired']),
    exitCode: z.number().int().min(-256).max(255).optional(),
    context: usageContextSchema,
  })
  .strict();
export type RecordStopInput = z.input<typeof recordStopInputSchema>;

export const recordAckSchema = z
  .object({
    intervalId: intervalIdSchema,
    durable: z.literal('pg'),
    dedup: z.boolean(),
  })
  .strict();
export type RecordAck = z.infer<typeof recordAckSchema>;

export const recordStartFailureCodeSchema = z.enum([
  'sku_not_found',
  'sku_unit_mismatch',
  'sku_not_accepting_new_usage',
]);
export type RecordStartFailureCode = z.infer<typeof recordStartFailureCodeSchema>;

export const recordStartResultSchema = z.discriminatedUnion('success', [
  z.object({ success: z.literal(true), ack: recordAckSchema }).strict(),
  z
    .object({
      success: z.literal(false),
      error: z
        .object({
          code: recordStartFailureCodeSchema,
          message: z.string().min(1),
        })
        .strict(),
    })
    .strict(),
]);
export type RecordStartResult = z.infer<typeof recordStartResultSchema>;

export const budgetVerdictSchema = z
  .object({
    verdict: z.enum(['continue', 'warn', 'stop']),
    remaining: z.number().finite().optional(),
  })
  .strict();
export type BudgetVerdict = z.infer<typeof budgetVerdictSchema>;

export const heartbeatAckSchema = recordAckSchema
  .extend({
    budget: budgetVerdictSchema,
  })
  .strict();
export type HeartbeatAck = z.infer<typeof heartbeatAckSchema>;

export type ContainerUsageRpcMethods = {
  recordStart: (input: RecordStartInput) => Promise<RecordStartResult>;
  recordHeartbeat: (input: RecordHeartbeatInput) => Promise<HeartbeatAck>;
  recordStop: (input: RecordStopInput) => Promise<RecordAck>;
};

export function intervalId(service: string, instanceId: string, startEpochMs: number): string {
  return `${keyPart(service)}:${keyPart(instanceId)}:${startEpochMs}`;
}

function keyPart(value: string): string {
  return encodeURIComponent(value);
}

export function startIdempotencyKey(
  service: string,
  instanceId: string,
  startEpochMs: number
): string {
  return `v1:${keyPart(service)}:${keyPart(instanceId)}:${startEpochMs}:start`;
}

export function heartbeatIdempotencyKey(
  service: string,
  instanceId: string,
  startEpochMs: number,
  seq: number
): string {
  return `v1:${keyPart(service)}:${keyPart(instanceId)}:${startEpochMs}:heartbeat:${seq}`;
}

export function stopIdempotencyKey(
  service: string,
  instanceId: string,
  startEpochMs: number
): string {
  return `v1:${keyPart(service)}:${keyPart(instanceId)}:${startEpochMs}:stop`;
}

export async function usageContextFingerprint(context: UsageContext): Promise<string> {
  const parsed = usageContextSchema.parse(context);
  const canonical = JSON.stringify({
    service: parsed.service,
    instanceId: parsed.instanceId,
    sku: parsed.sku,
    subject: parsed.subject,
    actor: parsed.actor,
    onBehalfOf: parsed.onBehalfOf,
    sessionId: parsed.sessionId,
    metadata: parsed.metadata
      ? Object.fromEntries(
          Object.entries(parsed.metadata).sort(([left], [right]) => left.localeCompare(right))
        )
      : undefined,
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
