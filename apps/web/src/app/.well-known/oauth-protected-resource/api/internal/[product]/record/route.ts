import { usageRecordResourceMetadata } from '@/lib/usage-record-auth';

// The answer follows the deployment's configuration, read on each request.
export const dynamic = 'force-dynamic';

/** RFC 9728 metadata of `/api/internal/<product>/record`; see `usageRecordResourceMetadata`. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ product: string }> }
): Promise<Response> {
  return usageRecordResourceMetadata((await params).product);
}
