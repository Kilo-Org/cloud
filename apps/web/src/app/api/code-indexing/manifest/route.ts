import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { handleTRPCRequest } from '@/lib/trpc-route-handler';

const OrganizationIdSchema = z.uuid();

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const organizationIdParam = searchParams.get('organizationId');
  const projectId = searchParams.get('projectId');
  const gitBranch = searchParams.get('gitBranch');

  if (!projectId || !gitBranch) {
    return new Response(
      JSON.stringify({
        error: 'Missing required parameters: organizationId, projectId, gitBranch',
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  let organizationId: string | undefined;
  if (organizationIdParam) {
    const parsedOrganizationId = OrganizationIdSchema.safeParse(organizationIdParam);
    if (!parsedOrganizationId.success) {
      return new Response(JSON.stringify({ error: 'Invalid organizationId' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    organizationId = parsedOrganizationId.data;
  }

  return handleTRPCRequest(request, async caller => {
    return caller.codeIndexing.getManifest({
      organizationId,
      projectId,
      gitBranch,
    });
  });
}
