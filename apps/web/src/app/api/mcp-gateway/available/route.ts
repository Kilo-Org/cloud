import 'server-only';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user/server';
import { createGatewayServices } from '@/lib/mcp-gateway/services';
import { executionContextFromAuth } from '@/lib/mcp-gateway/context';

export async function GET() {
  const { user, authFailedResponse, organizationId } = await getUserFromAuth({ adminOnly: false });
  if (authFailedResponse) return authFailedResponse;
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const services = createGatewayServices();
  return NextResponse.json(
    await services.availableService.listAvailableConfigs(
      user.id,
      executionContextFromAuth(organizationId)
    )
  );
}
