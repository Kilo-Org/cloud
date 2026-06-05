import 'server-only';
import { NextResponse, type NextRequest } from 'next/server';
import { createGatewayServices } from '@/lib/mcp-gateway/services';
import { gatewayErrorResponse, extractBearerToken } from '@/lib/mcp-gateway/http';

async function authenticatedClient(request: NextRequest) {
  const token = extractBearerToken(request.headers);
  if (!token) return null;
  const services = createGatewayServices();
  return { services, client: await services.clientService.findClientByRegistrationToken(token) };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ scope: string }> }
) {
  try {
    const auth = await authenticatedClient(request);
    const { scope: clientId } = await params;
    if (!auth?.client || auth.client.client_id !== clientId) {
      return NextResponse.json({ error: 'invalid_client' }, { status: 401 });
    }
    return NextResponse.json({
      client_id: auth.client.client_id,
      client_name: auth.client.client_name,
      redirect_uris: auth.client.redirect_uris,
      token_endpoint_auth_method: auth.client.token_endpoint_auth_method,
      grant_types: auth.client.grant_types,
      response_types: auth.client.response_types,
      scope: auth.client.declared_scopes.join(' '),
    });
  } catch (error) {
    return gatewayErrorResponse(error);
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ scope: string }> }
) {
  try {
    const auth = await authenticatedClient(request);
    const { scope: clientId } = await params;
    if (!auth?.client || auth.client.client_id !== clientId) {
      return NextResponse.json({ error: 'invalid_client' }, { status: 401 });
    }
    const body: unknown = await request.json();
    const updated = await auth.services.clientService.updateClient({ clientId, metadata: body });
    if (!updated) return NextResponse.json({ error: 'invalid_client' }, { status: 404 });
    return NextResponse.json({
      client_id: updated.client_id,
      client_name: updated.client_name,
      redirect_uris: updated.redirect_uris,
      token_endpoint_auth_method: updated.token_endpoint_auth_method,
      grant_types: updated.grant_types,
      response_types: updated.response_types,
      scope: updated.declared_scopes.join(' '),
    });
  } catch (error) {
    return gatewayErrorResponse(error);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ scope: string }> }
) {
  try {
    const auth = await authenticatedClient(request);
    const { scope: clientId } = await params;
    if (!auth?.client || auth.client.client_id !== clientId) {
      return NextResponse.json({ error: 'invalid_client' }, { status: 401 });
    }
    await auth.services.clientService.deleteClient(clientId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return gatewayErrorResponse(error);
  }
}
