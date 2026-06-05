import 'server-only';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user/server';
import { createGatewayServices } from '@/lib/mcp-gateway/services';
import { gatewayErrorResponse } from '@/lib/mcp-gateway/http';
import { parseScopedConnectPath } from '@kilocode/mcp-gateway';
import { executionContextFromAuth } from '@/lib/mcp-gateway/context';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ orgId: string; configId: string }> }
) {
  try {
    const { user, authFailedResponse, organizationId } = await getUserFromAuth({
      adminOnly: false,
    });
    if (authFailedResponse) return authFailedResponse;
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    const { orgId, configId } = await params;
    if (organizationId !== orgId) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    const services = createGatewayServices();
    const resolved = await services.repository.findActiveRouteByConfigId(configId);
    if (
      !resolved ||
      resolved.config.owner_scope !== 'organization' ||
      resolved.config.owner_id !== orgId
    ) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    const route = parseScopedConnectPath(new URL(resolved.route.canonical_url).pathname);
    if (!route) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    const token = await services.tokenService.mintDerivedConnectToken({
      route,
      userId: user.id,
      executionContext: executionContextFromAuth(organizationId),
    });
    return NextResponse.json({
      access_token: token.token,
      expires_at: token.expiresAt,
      token_type: 'bearer',
    });
  } catch (error) {
    return gatewayErrorResponse(error);
  }
}
