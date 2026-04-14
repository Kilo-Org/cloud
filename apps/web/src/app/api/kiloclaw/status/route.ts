import { NextResponse } from 'next/server';
import { TRPCError } from '@trpc/server';
import { getUserFromAuth } from '@/lib/user.server';
import { KiloClawUserClient } from '@/lib/kiloclaw/kiloclaw-user-client';
import { KiloClawApiError } from '@/lib/kiloclaw/kiloclaw-internal-client';
import { generateApiToken, TOKEN_EXPIRY } from '@/lib/tokens';
import {
  getActiveInstance,
  getActiveOrgInstance,
  workerInstanceId,
} from '@/lib/kiloclaw/instance-registry';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';

async function getAuthorizedOrganizationId(
  user: NonNullable<Awaited<ReturnType<typeof getUserFromAuth>>['user']>,
  organizationId?: string
) {
  if (!organizationId) {
    return undefined;
  }

  await ensureOrganizationAccess({ user }, organizationId);
  return organizationId;
}

export async function GET() {
  const { user, authFailedResponse, organizationId } = await getUserFromAuth({
    adminOnly: false,
  });
  if (authFailedResponse) return authFailedResponse;

  try {
    const authorizedOrganizationId = await getAuthorizedOrganizationId(user, organizationId);
    const instance = authorizedOrganizationId
      ? await getActiveOrgInstance(user.id, authorizedOrganizationId)
      : await getActiveInstance(user.id);

    // No org instance → 404 so the frontend renders setup entry points.
    // Without this guard workerInstanceId(null) → undefined → the worker
    // queries the personal DO, leaking personal status into the org context.
    if (authorizedOrganizationId && !instance) {
      return NextResponse.json(
        { error: 'No active instance for this organization' },
        { status: 404 }
      );
    }

    const token = generateApiToken(user, undefined, {
      expiresIn: TOKEN_EXPIRY.fiveMinutes,
    });
    const client = new KiloClawUserClient(token);
    const status = await client.getStatus({
      userId: user.id,
      instanceId: workerInstanceId(instance),
    });
    return NextResponse.json(status);
  } catch (err) {
    if (err instanceof TRPCError) {
      const status = err.code === 'UNAUTHORIZED' ? 403 : 500;
      return NextResponse.json({ error: err.message }, { status });
    }
    const status = err instanceof KiloClawApiError ? err.statusCode : 502;
    console.error('[api/kiloclaw/status] error:', err);
    return NextResponse.json({ error: 'KiloClaw request failed' }, { status });
  }
}
