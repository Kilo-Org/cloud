import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import * as z from 'zod';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import {
  adminActionContextFromHeaders,
  auditedAdminRoute,
  recordAdminActions,
  redactEmailAddressesInAuditText,
  setAdminAuditActor,
  userActionTarget,
} from '@kilocode/web-shared/lib/admin/admin-action-audit';
import { bulkBlockUsers, type BulkBlockResponse } from '@/lib/abuse/bulkBlock';

const schema = z.object({
  kilo_user_emails_or_ids: z.array(z.string().min(1)).min(1),
  block_reason: z.string().trim().min(1),
});

export const POST = auditedAdminRoute(
  { kind: 'handler', actions: ['user.bulk_block'] },
  async (request: NextRequest): Promise<NextResponse<BulkBlockResponse | { error: string }>> => {
    const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: true });
    if (authFailedResponse) return authFailedResponse;
    setAdminAuditActor(user);

    const body: unknown = await request.json().catch(() => undefined);
    const parsed = schema.safeParse(body);
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
    const blockReason = redactEmailAddressesInAuditText(block_reason);
    // One row per user the update actually blocked.
    const result = await bulkBlockUsers(kilo_user_emails_or_ids, block_reason, user.id, userIds =>
      recordAdminActions(
        adminActionContextFromHeaders(user, request.headers),
        userIds.map(userId => ({
          action: 'user.bulk_block',
          target: userActionTarget(userId),
          message: 'Blocked in a bulk block',
          metadata: { blockReason, batchSize: userIds.length },
        }))
      )
    );
    const status = result.success ? 200 : 400;
    return NextResponse.json(result, { status });
  }
);
