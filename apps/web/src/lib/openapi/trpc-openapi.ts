import * as z from 'zod';
import {
  publicTrpcOpenApiProcedures,
  type TrpcOpenApiProcedure,
} from '@/lib/openapi/trpc-registry';
import { TrpcErrorResponseSchema, trpcSuccessResponseJsonSchema } from '@/lib/trpc/transport';

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
  return trpcSuccessResponseJsonSchema(data);
}

function errorResponse(description: string) {
  return {
    description,
    content: {
      'application/json': {
        schema: zodToJsonSchema(TrpcErrorResponseSchema),
      },
    },
  };
}

function requestShapeForProcedure(procedure: TrpcOpenApiProcedure) {
  const schema = zodToJsonSchema(procedure.input);

  if (procedure.method === 'get') {
    return {
      parameters: [
        {
          name: 'input',
          in: 'query',
          required: true,
          description: 'URL-encoded JSON tRPC input payload.',
          content: {
            'application/json': {
              schema,
            },
          },
        },
      ],
    };
  }

  return {
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema,
        },
      },
    },
  };
}

function operationForProcedure(procedure: TrpcOpenApiProcedure) {
  const routeSpecificErrorResponses = Object.fromEntries(
    Object.entries(procedure.errorResponses ?? {}).map(([status, description]) => [
      status,
      errorResponse(description),
    ])
  );

  return {
    operationId: procedure.procedurePath.replaceAll('.', '_'),
    tags: procedure.tags,
    summary: procedure.summary,
    description: procedure.description,
    security: [{ bearerAuth: [] }],
    ...requestShapeForProcedure(procedure),
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
      ...routeSpecificErrorResponses,
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
      title: 'Kilo Code API',
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
