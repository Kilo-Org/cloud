import 'server-only';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { generateApiToken } from '@kilocode/web-shared/lib/tokens';
import { getUserOrgMemberships } from '@kilocode/web-shared/lib/organizations/organizations';
import {
  recordKiloAdminElevationForRequest,
  serviceTarget,
} from '@kilocode/web-shared/lib/admin/admin-access-log';
import {
  isWorkerAdminCapabilityIssuanceEnabled,
  isWorkerAdminLegacyClaimIssuanceEnabled,
} from '@kilocode/web-shared/lib/config.server';
import { WASTELAND_ADMIN_AUDIENCE } from '@kilocode/worker-utils/worker-admin-capability';
import {
  AdminCapabilityRequestSchema,
  WorkerAdminCapabilityIssuanceError,
  issueWorkerAdminCapability,
} from '@/lib/worker-admin/capability-issuer';
import { requireWorkerAdminActor, WorkerAdminActorError } from '@/lib/worker-admin/actor-guard';

const ONE_HOUR_SECONDS = 60 * 60;

/**
 * POST /api/wasteland/token
 *
 * Mints a short-lived (1 hour) Kilo JWT that the browser can use to
 * authenticate directly with the Wasteland Cloudflare Worker.
 *
 * With no body, this is the ordinary identity token. A body of
 * `{ adminCapability: { target, actions? } }` additionally mints a scoped,
 * short-lived ES256 capability. See /api/gastown/token for the same contract.
 */
export async function POST(request: Request) {
  const { user, authFailedResponse, tokenSource } = await getUserFromAuth({ adminOnly: false });
  if (authFailedResponse) return authFailedResponse;
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const rawBody: unknown = await request.json().catch(() => null);
  const hasCapabilityRequest =
    typeof rawBody === 'object' && rawBody !== null && 'adminCapability' in rawBody;
  const capabilityRequest = hasCapabilityRequest
    ? AdminCapabilityRequestSchema.safeParse(rawBody)
    : null;
  if (capabilityRequest !== null && !capabilityRequest.success) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const legacyIssuance = isWorkerAdminLegacyClaimIssuanceEnabled();

  if (legacyIssuance && user.is_admin) {
    await recordKiloAdminElevationForRequest({
      user,
      tokenSource,
      reason: 'service_token_mint',
      target: serviceTarget('wasteland'),
    });
  }

  const orgMemberships = await getUserOrgMemberships(user.id);
  const token = generateApiToken(
    user,
    {
      ...(legacyIssuance && user.is_admin ? { isAdmin: true } : {}),
      orgMemberships,
    },
    { expiresIn: ONE_HOUR_SECONDS }
  );
  const expiresAt = new Date(Date.now() + 55 * 60 * 1000).toISOString();

  if (capabilityRequest !== null) {
    const { target, actions } = capabilityRequest.data.adminCapability;
    try {
      const actor = await requireWorkerAdminActor(request, request.headers, {
        actionClass: 'worker_admin',
        target: { kind: 'service', id: 'wasteland' },
        inventoryId: 'rest.wastelandToken',
      });
      if (actor.actor.assurance.userId !== user.id) {
        return NextResponse.json(
          { error: 'Worker admin capabilities require the same authenticated user' },
          { status: 403 }
        );
      }
      const issued = await issueWorkerAdminCapability({
        user: { ...user, api_token_pepper: actor.sessionBinding.apiTokenPepper },
        audience: WASTELAND_ADMIN_AUDIENCE,
        target,
        actions,
        headersList: request.headers,
      });
      return NextResponse.json({
        token,
        expiresAt,
        admin: user.is_admin === true,
        capabilityIssuance: true,
        capability: issued.capability,
        capabilityExpiresAt: issued.capabilityExpiresAt,
      });
    } catch (error) {
      if (error instanceof WorkerAdminActorError) {
        return NextResponse.json(
          { error: error.message, code: error.code },
          { status: error.status }
        );
      }
      if (error instanceof WorkerAdminCapabilityIssuanceError) {
        return NextResponse.json(
          { error: error.message, code: error.code },
          { status: error.status }
        );
      }
      throw error;
    }
  }

  return NextResponse.json({
    token,
    expiresAt,
    admin: user.is_admin === true,
    capabilityIssuance: isWorkerAdminCapabilityIssuanceEnabled(),
  });
}
