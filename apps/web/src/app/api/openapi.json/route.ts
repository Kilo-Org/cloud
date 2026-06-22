import { generateTrpcOpenApiDocument } from '@/lib/openapi/trpc-openapi';

export function GET() {
  return Response.json(generateTrpcOpenApiDocument());
}
