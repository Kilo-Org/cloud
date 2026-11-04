import type { TRPCDefaultErrorShape, TRPCErrorFormatter } from '@trpc/server';
import { parseCustomerBillingFailure } from '@kilocode/cloud-agent-sdk';
import { StepUpRequiredError } from '@kilocode/web-shared/lib/admin/privileged-access';
import * as z from 'zod';

type JsonSchema = Record<string, unknown>;

/**
 * Marker class used to attach an upstream API error code to a TRPCError so the
 * error-formatter can surface it to the client in `err.data.upstreamCode`.
 *
 * Usage:
 *   throw new TRPCError({
 *     code: 'CONFLICT',
 *     message: 'Config was modified',
 *     cause: new UpstreamApiError('etag_mismatch'),
 *   });
 *
 * The client then sees `err.data.upstreamCode === 'etag_mismatch'`.
 */
export class UpstreamApiError extends Error {
  constructor(public readonly upstreamCode: string) {
    super(upstreamCode);
    this.name = 'UpstreamApiError';
  }
}

/**
 * Marker for the context-level UNAUTHORIZED (no authenticated user / invalid
 * token). The error-formatter surfaces it as `data.authRequired`, letting the
 * mobile client sign the user out ONLY on a genuine session failure — and not
 * on a procedure-level UNAUTHORIZED (e.g. org-access denial via
 * ensureOrganizationAccess), which must be handled in-screen as a permission
 * error rather than logging the whole app out.
 */
export class AuthContextError extends Error {
  constructor() {
    super('auth_context');
    this.name = 'AuthContextError';
  }
}

export const TrpcZodFlattenedErrorSchema = z.object({
  formErrors: z.array(z.string()),
  fieldErrors: z.record(z.string(), z.array(z.string())),
});

export const TrpcErrorDataSchema = z
  .object({
    code: z.string(),
    httpStatus: z.number(),
    stack: z.string().optional(),
    path: z.string().optional(),
    zodError: TrpcZodFlattenedErrorSchema.nullable(),
    upstreamCode: z.string().optional(),
    authRequired: z.boolean().optional(),
    stepUp: z
      .object({
        code: z.string(),
        actionClass: z.string(),
        purpose: z.string(),
        maxAgeSeconds: z.number(),
      })
      .optional(),
  })
  .passthrough();

export const TrpcErrorResponseSchema = z.object({
  error: z.object({
    message: z.string(),
    code: z.number(),
    data: TrpcErrorDataSchema,
  }),
});

export function trpcSuccessResponseSchema<DataSchema extends z.ZodType>(dataSchema: DataSchema) {
  return z
    .object({
      result: z
        .object({
          data: dataSchema,
        })
        .passthrough(),
    })
    .passthrough();
}

export function trpcSuccessResponseJsonSchema(dataSchema: JsonSchema): JsonSchema {
  return {
    type: 'object',
    properties: {
      result: {
        type: 'object',
        properties: {
          data: dataSchema,
        },
        required: ['data'],
        additionalProperties: true,
      },
    },
    required: ['result'],
    additionalProperties: true,
  };
}

export type KiloTrpcErrorData = TRPCDefaultErrorShape['data'] &
  z.infer<typeof TrpcErrorDataSchema> & {
    /** Client-visible reason for a support access denial. */
    supportAccessReason?: string;
  };

export type KiloTrpcErrorShape = Omit<TRPCDefaultErrorShape, 'data'> & {
  data: KiloTrpcErrorData;
};

export const trpcErrorFormatter = (({ shape, error }) => {
  // Cloud Agent's worker tRPC error is rethrown with a structured cause. Parse
  // it through the SDK contract before exposing it at the browser boundary.
  const billingFailure = parseCustomerBillingFailure({ data: error.cause });
  const supportAccessReason = readSupportAccessReason(error.cause);

  return {
    ...shape,
    data: {
      ...shape.data,
      zodError:
        error.code === 'BAD_REQUEST' && error.cause instanceof z.ZodError
          ? z.flattenError(error.cause)
          : null,
      upstreamCode: error.cause instanceof UpstreamApiError ? error.cause.upstreamCode : undefined,
      authRequired: error.cause instanceof AuthContextError ? true : undefined,
      stepUp:
        error.cause instanceof StepUpRequiredError
          ? {
              code: error.cause.code,
              actionClass: error.cause.actionClass,
              purpose: error.cause.purpose,
              maxAgeSeconds: error.cause.maxAgeSeconds,
            }
          : undefined,
      ...(billingFailure ? { billingFailure } : {}),
      ...(supportAccessReason ? { supportAccessReason } : {}),
    },
  };
}) satisfies TRPCErrorFormatter<unknown, KiloTrpcErrorShape>;

function readSupportAccessReason(cause: unknown): string | undefined {
  if (cause === null || typeof cause !== 'object') return undefined;
  const value = (cause as { supportAccessReason?: unknown }).supportAccessReason;
  return typeof value === 'string' ? value : undefined;
}
