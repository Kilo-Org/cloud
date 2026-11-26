import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { listBlacklistedDomains } from '@kilocode/web-shared/lib/blacklist-domains-config';
import {
  addAdminAuditMetadata,
  adminActionContextFromHeaders,
  auditedAdminRoute,
  recordAdminActions,
  setAdminAuditActor,
  userActionTarget,
} from '@kilocode/web-shared/lib/admin/admin-action-audit';
import {
  backfillBlockBlacklistedDomainsBatch,
  findBlacklistedEmailDomains,
  type BlockBlacklistedDomainsBackfillResponse,
} from '@/lib/abuse/block-blacklisted-domains';

export type BlockBlacklistedDomainsCountsResponse = {
  unblocked: number;
};

export async function GET(): Promise<
  NextResponse<BlockBlacklistedDomainsCountsResponse | { error: string }>
> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const domains = await listBlacklistedDomains(readDb);
  if (domains.length === 0) {
    return NextResponse.json({ unblocked: 0 });
  }

  const matchingDomains = await findBlacklistedEmailDomains(domains);
  const unblocked = matchingDomains.reduce((sum, row) => sum + row.count, 0);

  return NextResponse.json({ unblocked });
}

// One summary row for the run, plus one row per user a batch blocked.
export const POST = auditedAdminRoute(
  { kind: 'declarative', action: 'backfill.block_blacklisted_domains.run' },
  async (
    request: Request
  ): Promise<NextResponse<BlockBlacklistedDomainsBackfillResponse | { error: string }>> => {
    const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: true });
    if (authFailedResponse) return authFailedResponse;
    setAdminAuditActor(user);

    const auditContext = adminActionContextFromHeaders(user, request.headers);
    const domains = await listBlacklistedDomains();
    const result = await backfillBlockBlacklistedDomainsBatch({
      actorId: user.id,
      domains,
      onBlocked: userIds =>
        recordAdminActions(
          auditContext,
          userIds.map(userId => ({
            action: 'user.domain_block',
            target: userActionTarget(userId),
            message: 'Blocked for a blacklisted email domain',
          }))
        ),
    });
    addAdminAuditMetadata({ ...result, blacklistedDomainCount: domains.length });
    return NextResponse.json(result);
  }
);
