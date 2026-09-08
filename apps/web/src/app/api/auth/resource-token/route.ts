import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user/server';
import {
  createDelegatedResourceToken,
  isDelegableResource,
  TypedResourceDelegationError,
} from '@/lib/auth/resource-delegation';

function isSameOriginRequest(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  return origin !== null && origin === request.nextUrl.origin;
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const resource =
    body && typeof body === 'object' && 'resource' in body ? body.resource : undefined;
  if (!isDelegableResource(resource)) {
    return NextResponse.json({ error: 'Unsupported resource' }, { status: 400 });
  }
  if (!request.headers.has('authorization') && !isSameOriginRequest(request)) {
    return NextResponse.json({ error: 'Invalid request origin' }, { status: 403 });
  }
  const { user, authFailedResponse, organizationId, tokenSource } = await getUserFromAuth({
    adminOnly: false,
  });
  if (authFailedResponse) return authFailedResponse;
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (organizationId) {
    return NextResponse.json(
      { error: 'Organization credentials are not supported' },
      { status: 403 }
    );
  }
  try {
    const result = await createDelegatedResourceToken(user, resource, {
      headers: request.headers,
      tokenSource,
    });
    return NextResponse.json({ token: result.token, expiresAt: result.expiresAt });
  } catch (error) {
    if (error instanceof TypedResourceDelegationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
