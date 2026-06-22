import { generateTrpcOpenApiDocument } from '@/lib/openapi/trpc-openapi';

const openApiDocument = generateTrpcOpenApiDocument();

export function GET() {
  return Response.json(openApiDocument, {
    headers: {
      'cache-control': 'public, max-age=3600',
    },
  });
}
