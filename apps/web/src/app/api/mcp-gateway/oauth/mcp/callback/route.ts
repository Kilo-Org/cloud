import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { getUserFromAuth } from '@/lib/user/server';
import { createGatewayServices } from '@/lib/mcp-gateway/services';
import { gatewayErrorResponse } from '@/lib/mcp-gateway/http';

export async function GET(request: NextRequest) {
  try {
    const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: false });
    if (authFailedResponse) return authFailedResponse;
    if (!user) return NextResponse.redirect(new URL('/users/sign_in', request.nextUrl.origin));

    const state = request.nextUrl.searchParams.get('state');
    const code = request.nextUrl.searchParams.get('code');
    const providerError = request.nextUrl.searchParams.get('error');
    if (!state) {
      return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    }
    const services = createGatewayServices();
    if (providerError) {
      await services.providerOAuthService.consumeProviderError({ state, userId: user.id });
      return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    }
    if (!code) {
      await services.providerOAuthService.consumeProviderError({ state, userId: user.id });
      return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    }
    const callback = await services.providerOAuthService.handleProviderCallback({
      state,
      code,
      userId: user.id,
    });
    const finalized = await services.authorizationService.completeProviderAuthorization({
      authorizationRequest: callback.authorizationRequest,
    });
    return NextResponse.redirect(finalized.redirectUrl);
  } catch (error) {
    return gatewayErrorResponse(error);
  }
}
