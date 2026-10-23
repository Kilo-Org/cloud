import type { NextRequest } from 'next/server';
import { handleTRPCRequest } from '@/lib/trpc-route-handler';
import { CODE_INDEXING_ENABLED } from '@kilocode/web-shared/lib/config.server';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const organizationId = (await params).id;

  return handleTRPCRequest(request, async caller => {
    const org = await caller.organizations.withMembers({ organizationId });
    const res = {
      id: org.id,
      name: org.name,
      settings: org.settings || {},
    };
    // set this to false if its undefined, fixes extension coalescing undefined to true
    res.settings.code_indexing_enabled = CODE_INDEXING_ENABLED
      ? (res.settings.code_indexing_enabled ?? false)
      : false;
    return res;
  });
}
