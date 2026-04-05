import type { NextRequest } from 'next/server';
import { handleTRPCRequest } from '@/lib/trpc-route-handler';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const organizationId = searchParams.get('organizationId') || undefined;
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

  return handleTRPCRequest(request, async caller => {
    return caller.codeIndexing.getManifest({
      organizationId,
      projectId,
      gitBranch,
    });
  });
}
