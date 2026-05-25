import { connection, type NextRequest } from 'next/server';
import { eq } from 'drizzle-orm';
import * as z from 'zod';
import { model_experiment_request } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { getPromptByHash } from '@/lib/r2/experiment-prompts';
import { getUserFromAuth } from '@/lib/user/server';

const UsageIdSchema = z.string().uuid();
const STORED_BODY_HASH = /^[0-9a-f]{64}$/;

function jsonError(error: string, status: number) {
  return Response.json({ error }, { status });
}

export async function GET(request: NextRequest) {
  await connection();

  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) {
    return authFailedResponse;
  }

  const parsedUsageId = UsageIdSchema.safeParse(request.nextUrl.searchParams.get('usageId'));
  if (!parsedUsageId.success) {
    return jsonError('A valid usageId is required', 400);
  }

  const row = await db.query.model_experiment_request.findFirst({
    columns: {
      request_body_sha256: true,
      was_truncated: true,
    },
    where: eq(model_experiment_request.usage_id, parsedUsageId.data),
  });
  if (!row) {
    return jsonError('Experiment request not found', 404);
  }
  if (row.request_body_sha256 === '__deleted__') {
    return jsonError('Captured request body was deleted', 410);
  }
  if (row.request_body_sha256 === '__failed__' || !STORED_BODY_HASH.test(row.request_body_sha256)) {
    return jsonError('Captured request body is not available', 404);
  }

  const body = await getPromptByHash(row.request_body_sha256);
  if (body === null) {
    return jsonError('Captured request body was not found in storage', 404);
  }

  const extension = row.was_truncated ? 'json.part' : 'json';
  return new Response(body, {
    headers: {
      'Cache-Control': 'private, no-store',
      'Content-Disposition': `attachment; filename="experiment-request-${parsedUsageId.data}.${extension}"`,
      'Content-Type': row.was_truncated
        ? 'text/plain; charset=utf-8'
        : 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
