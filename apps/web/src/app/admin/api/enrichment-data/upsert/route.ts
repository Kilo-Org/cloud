import type { NextRequest } from 'next/server';
import { auditedAdminRoute } from '@kilocode/web-shared/lib/admin/admin-action-audit';
import { handleTRPCRequest } from '@/lib/trpc-route-handler';
import type { enrichment_data } from '@kilocode/db/schema';

type EnrichmentData = typeof enrichment_data.$inferSelect;

export const PUT = auditedAdminRoute(
  {
    kind: 'exempt',
    reason:
      'covered by tRPC admin.enrichmentData.upsert, whose adminAudit meta records user.enrichment_data.upsert',
  },
  async (request: NextRequest) => {
    const body = await request.json();

    return handleTRPCRequest<{ success: boolean; data: EnrichmentData }>(request, async caller => {
      const result = await caller.admin.enrichmentData.upsert(body);
      return result;
    });
  }
);
