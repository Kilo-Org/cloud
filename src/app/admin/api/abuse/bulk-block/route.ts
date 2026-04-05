import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import * as z from 'zod';
import { getUserFromAuth } from '@/lib/user.server';
import { bulkBlockUsers, type BulkBlockResponse } from '@/lib/abuse/bulkBlock';

const schema = z.object({
  kilo_user_emails_or_ids: z.array(z.string().min(1)).min(1),
  block_reason: z.string().min(1),
});

export async function POST(
  request: NextRequest
): Promise<NextResponse<BulkBlockResponse | { error: string }>> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success)
    return NextResponse.json(
      {
        success: false,
        error: `Validation error: ${parsed.error.issues.map(i => i.message).join(', ')}`,
        foundIds: [],
      },
      { status: 400 }
    );
  const { kilo_user_emails_or_ids, block_reason } = parsed.data;
  const result = await bulkBlockUsers(kilo_user_emails_or_ids, block_reason);
  const status = result.success ? 200 : 400;
  return NextResponse.json(result, { status });
}
