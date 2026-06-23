import { describe, expect, it } from '@jest/globals';
import { TRPCError, initTRPC } from '@trpc/server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import * as z from 'zod';
import { publicTrpcOpenApiProcedures } from '@/lib/openapi/trpc-registry';
import { generateTrpcOpenApiDocument } from '@/lib/openapi/trpc-openapi';
import {
  TrpcErrorResponseSchema,
  UpstreamApiError,
  trpcErrorFormatter,
  trpcSuccessResponseSchema,
} from '@/lib/trpc/transport';

const t = initTRPC.create({ errorFormatter: trpcErrorFormatter });

const verificationRouter = t.router({
  greeting: t.procedure
    .input(z.object({ name: z.string() }))
    .query(({ input }) => ({ greeting: `Hello, ${input.name}` })),
  upstreamFailure: t.procedure.query(() => {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'Config was modified',
      cause: new UpstreamApiError('etag_mismatch'),
    });
  }),
});

async function callVerificationProcedure(path: string, input?: unknown): Promise<unknown> {
  const url = new URL(`http://localhost/api/trpc/${path}`);
  if (input !== undefined) url.searchParams.set('input', JSON.stringify(input));

  const response = await fetchRequestHandler({
    endpoint: '/api/trpc',
    req: new Request(url, { method: 'GET' }),
    router: verificationRouter,
    createContext: async () => ({}),
  });

  return response.json() as Promise<unknown>;
}

describe('generateTrpcOpenApiDocument', () => {
  it('documents only the allowlisted tRPC procedures', () => {
    const document = generateTrpcOpenApiDocument();

    expect(Object.keys(document.paths).sort()).toEqual(
      publicTrpcOpenApiProcedures.map(procedure => `/api/trpc/${procedure.procedurePath}`).sort()
    );
    expect(document.paths['/api/trpc/usageAnalytics.getTable']?.get).toMatchObject({
      operationId: 'usageAnalytics_getTable',
      summary: 'Return aggregated tabular usage rows',
      tags: ['Usage Analytics'],
    });
    expect(document.paths).not.toHaveProperty('/api/trpc/admin');
  });

  it('documents bearer auth metadata for protected procedures', () => {
    const document = generateTrpcOpenApiDocument();

    expect(document.components.securitySchemes.bearerAuth).toEqual({
      type: 'http',
      scheme: 'bearer',
    });

    for (const pathItem of Object.values(document.paths)) {
      for (const operation of Object.values(pathItem)) {
        expect(operation).toHaveProperty('security', [{ bearerAuth: [] }]);
      }
    }
  });

  it('generates request and response schemas for usageAnalytics.getTable', () => {
    const document = generateTrpcOpenApiDocument();
    const operation = document.paths['/api/trpc/usageAnalytics.getTable']?.get;

    expect(operation).toMatchObject({
      parameters: [
        {
          name: 'input',
          in: 'query',
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: expect.arrayContaining([
                  'startDate',
                  'endDate',
                  'granularity',
                  'groupBy',
                ]),
                properties: {
                  groupBy: {
                    type: 'array',
                    items: { enum: ['feature', 'model', 'mode', 'user', 'provider', 'project'] },
                  },
                  limit: { default: 1000 },
                },
              },
            },
          },
        },
      ],
      responses: {
        '200': {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['result'],
                properties: {
                  result: {
                    type: 'object',
                    required: ['data'],
                    properties: {
                      data: {
                        type: 'object',
                        required: ['rows', 'effectiveGranularity'],
                        properties: {
                          rows: { type: 'array' },
                          effectiveGranularity: { enum: ['hour', 'day', 'week', 'month'] },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        '400': {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: {
                  error: {
                    type: 'object',
                    required: ['message', 'code', 'data'],
                    properties: {
                      data: {
                        type: 'object',
                        required: expect.arrayContaining(['code', 'httpStatus', 'zodError']),
                        properties: {
                          code: { type: 'string' },
                          httpStatus: { type: 'number' },
                          zodError: {
                            anyOf: expect.arrayContaining([{ type: 'null' }]),
                          },
                          upstreamCode: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
  });

  it('matches the actual tRPC success and error transport envelopes', async () => {
    const success = trpcSuccessResponseSchema(z.object({ greeting: z.string() })).parse(
      await callVerificationProcedure('greeting', { name: 'Ada' })
    );
    expect(success.result.data).toEqual({ greeting: 'Hello, Ada' });

    const badInput = TrpcErrorResponseSchema.parse(
      await callVerificationProcedure('greeting', { name: 123 })
    );
    expect(badInput.error.data.code).toBe('BAD_REQUEST');
    expect(badInput.error.data.httpStatus).toBe(400);
    expect(badInput.error.data.zodError?.fieldErrors).toHaveProperty('name');

    const upstreamFailure = TrpcErrorResponseSchema.parse(
      await callVerificationProcedure('upstreamFailure')
    );
    expect(upstreamFailure.error.data.code).toBe('CONFLICT');
    expect(upstreamFailure.error.data.httpStatus).toBe(409);
    expect(upstreamFailure.error.data.zodError).toBeNull();
    expect(upstreamFailure.error.data.upstreamCode).toBe('etag_mismatch');
  });
});
