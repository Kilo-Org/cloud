import type { TRPCDefaultErrorShape, TRPCErrorFormatter } from '@trpc/server';
import * as z from 'zod';

type JsonSchema = Record<string, unknown>;

export class UpstreamApiError extends Error {
  constructor(public readonly upstreamCode: string) {
    super(upstreamCode);
    this.name = 'UpstreamApiError';
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

export type KiloTrpcErrorData = TRPCDefaultErrorShape['data'] & z.infer<typeof TrpcErrorDataSchema>;

export type KiloTrpcErrorShape = Omit<TRPCDefaultErrorShape, 'data'> & {
  data: KiloTrpcErrorData;
};

export const trpcErrorFormatter = (({ shape, error }) => ({
  ...shape,
  data: {
    ...shape.data,
    zodError:
      error.code === 'BAD_REQUEST' && error.cause instanceof z.ZodError
        ? z.flattenError(error.cause)
        : null,
    upstreamCode: error.cause instanceof UpstreamApiError ? error.cause.upstreamCode : undefined,
  },
})) satisfies TRPCErrorFormatter<unknown, KiloTrpcErrorShape>;
