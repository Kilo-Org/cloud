import { createHmac } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { NEXTAUTH_SECRET } from '@kilocode/web-shared/lib/config.server';
import {
  PERMISSION_POLICY_MAX_AGE_SECONDS,
  PermissionPolicyExecutionOsSchema,
} from '@kilocode/web-shared/lib/organizations/group-policies/permission-policy/permission-policy.schema';
import { getNamedPolicyMemberSnapshot } from '@kilocode/web-shared/lib/organizations/group-policies/permission-policy/named-policy.server';
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

    const query = new URL(request.url).searchParams;
    const os = PermissionPolicyExecutionOsSchema.optional().safeParse(query.get('os') ?? undefined);
    if (!os.success || query.size !== (os.data === undefined ? 0 : 1)) {
      return errorResponse(400, 'Invalid execution OS selector');
    }

    const snapshot = await getNamedPolicyMemberSnapshot({
      organizationId,
      kiloUserId: auth.user.id,
      executionOs: os.data === 'other' ? undefined : os.data,
    });
    const response = {
      schema_version: 1 as const,
      organization_id: organizationId,
      managed: snapshot.managed,
      revision: snapshot.policyRevision,
      max_age_seconds: PERMISSION_POLICY_MAX_AGE_SECONDS,
      policy: snapshot.policy,
    };
    const body = JSON.stringify(response);
    const digest = createHmac('sha256', NEXTAUTH_SECRET)
      .update(
        JSON.stringify(['organization-permission-policy', auth.user.id, organizationId, os.data])
      )
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
