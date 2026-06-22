import { describe, expect, it } from '@jest/globals';
import { publicTrpcOpenApiProcedures } from '@/lib/openapi/trpc-registry';
import { generateTrpcOpenApiDocument } from '@/lib/openapi/trpc-openapi';

describe('generateTrpcOpenApiDocument', () => {
  it('documents only the allowlisted tRPC procedures', () => {
    const document = generateTrpcOpenApiDocument();

    expect(Object.keys(document.paths).sort()).toEqual(
      publicTrpcOpenApiProcedures.map(procedure => `/api/trpc/${procedure.procedurePath}`).sort()
    );
    expect(document.paths['/api/trpc/usageAnalytics.getTable']?.post).toMatchObject({
      operationId: 'usageAnalytics_getTable',
      summary: 'Get tabular usage analytics',
      tags: ['Usage Analytics'],
    });
    expect(document.paths).not.toHaveProperty('/api/trpc/admin');
  });

  it('generates request and response schemas for usageAnalytics.getTable', () => {
    const document = generateTrpcOpenApiDocument();
    const operation = document.paths['/api/trpc/usageAnalytics.getTable']?.post;

    expect(operation).toMatchObject({
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: expect.arrayContaining(['startDate', 'endDate', 'granularity', 'groupBy']),
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
      },
    });
  });
});
