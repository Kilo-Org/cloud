import type { NextRequest } from 'next/server';
import { handleTRPCRequest } from '@/lib/trpc-route-handler';
import type { enrichment_data } from '@kilocode/db/schema';

type EnrichmentData = typeof enrichment_data.$inferSelect;

export async function PUT(request: NextRequest) {
  const body = await request.json();

  return handleTRPCRequest<{ success: boolean; data: EnrichmentData }>(request, async caller => {
    const result = await caller.admin.enrichmentData.upsert(body);
    return result;
  });
}
