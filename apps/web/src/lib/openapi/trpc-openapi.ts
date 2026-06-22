import * as z from 'zod';
import {
  publicTrpcOpenApiProcedures,
  type TrpcOpenApiProcedure,
} from '@/lib/openapi/trpc-registry';

type JsonSchema = Record<string, unknown>;

type OpenApiDocument = {
  openapi: '3.1.0';
  info: {
    title: string;
    version: string;
  };
  servers: { url: string }[];
  tags: { name: string }[];
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http';
        scheme: 'bearer';
      };
    };
  };
  paths: Record<string, Record<string, unknown>>;
};

function zodToJsonSchema(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema, { target: 'draft-7' }) as JsonSchema;
}

function pathForProcedure(procedure: TrpcOpenApiProcedure): `/api/trpc/${string}` {
  return `/api/trpc/${procedure.procedurePath}`;
}

function successResponseSchema(data: JsonSchema): JsonSchema {
  return {
    type: 'object',
    properties: {
      result: {
        type: 'object',
        properties: {
          data,
        },
        required: ['data'],
        additionalProperties: true,
      },
    },
    required: ['result'],
    additionalProperties: true,
  };
}

function errorResponse(description: string) {
  return {
    description,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                message: { type: 'string' },
                code: { type: 'number' },
                data: {
                  type: 'object',
                  additionalProperties: true,
                },
              },
              required: ['message', 'code'],
              additionalProperties: true,
            },
          },
          required: ['error'],
          additionalProperties: true,
        },
      },
    },
  };
}

function operationForProcedure(procedure: TrpcOpenApiProcedure) {
  return {
    operationId: procedure.procedurePath.replaceAll('.', '_'),
    tags: procedure.tags,
    summary: procedure.summary,
    description: procedure.description,
    security: [{ bearerAuth: [] }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: zodToJsonSchema(procedure.input),
        },
      },
    },
    responses: {
      '200': {
        description: 'Successful tRPC response',
        content: {
          'application/json': {
            schema: successResponseSchema(zodToJsonSchema(procedure.output)),
          },
        },
      },
      '400': errorResponse('Invalid request'),
      '401': errorResponse('Authentication required'),
      '403': errorResponse('Access denied'),
      '500': errorResponse('Unexpected server error'),
    },
  };
}

export function generateTrpcOpenApiDocument(): OpenApiDocument {
  const paths: OpenApiDocument['paths'] = {};
  const tagNames = new Set<string>();

  for (const procedure of publicTrpcOpenApiProcedures) {
    for (const tag of procedure.tags) tagNames.add(tag);
    const path = pathForProcedure(procedure);
    paths[path] = {
      ...paths[path],
      [procedure.method]: operationForProcedure(procedure),
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Kilo Code tRPC API',
      version: '1.0.0',
    },
    servers: [{ url: '/' }],
    tags: [...tagNames].sort().map(name => ({ name })),
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
        },
      },
    },
    paths,
  };
}
