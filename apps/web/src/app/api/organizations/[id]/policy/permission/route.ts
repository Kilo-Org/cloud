import { createHmac } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { NEXTAUTH_SECRET } from '@kilocode/web-shared/lib/config.server';
import { getOrganizationPermissionPolicy } from '@kilocode/web-shared/lib/organizations/group-policies/permission-policy/permission-policy.server';
import { getUserFromAccountBearer, uuidSchema } from '@kilocode/web-shared/lib/user/server';
import { errorExceptInTest } from '@kilocode/web-shared/lib/utils.server';

const cacheControl = 'private, no-store';

function errorResponse(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: { 'Cache-Control': cacheControl } });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  try {
    const auth = await getUserFromAccountBearer(request.headers);
    if (!auth.user) {
      auth.authFailedResponse.headers.set('Cache-Control', cacheControl);
      return auth.authFailedResponse;
    }

    const id = uuidSchema.safeParse((await params).id);
    if (!id.success) return errorResponse(400, 'Invalid organization ID');
    const organizationId = id.data.toLowerCase();
    if (auth.organizationId !== undefined && auth.organizationId.toLowerCase() !== organizationId) {
      return errorResponse(
        403,
        'Organization credential does not match the requested organization'
      );
    }

    const { response } = await getOrganizationPermissionPolicy(organizationId, auth.user.id);
    const body = JSON.stringify(response);
    const digest = createHmac('sha256', NEXTAUTH_SECRET)
      .update(JSON.stringify(['organization-permission-policy', auth.user.id, organizationId]))
      .update(body)
      .digest('base64url');
    const etag = `"${digest}"`;
    const headers = new Headers({ 'Cache-Control': cacheControl, ETag: etag });
    if (request.headers.get('If-None-Match') === etag) {
      return new Response(null, { status: 304, headers });
    }

    headers.set('Content-Type', 'application/json');
    return new Response(body, { headers });
  } catch (error) {
    if (error instanceof TRPCError) {
      if (error.code === 'UNAUTHORIZED') return errorResponse(403, 'Organization access denied');
      if (error.code === 'NOT_FOUND') return errorResponse(404, 'Organization not found');
    }
    errorExceptInTest('Failed to resolve organization permission policy');
    return errorResponse(500, 'Organization permission policy is unavailable');
  }
}
