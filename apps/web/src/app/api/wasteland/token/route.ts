import 'server-only';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { generateApiToken } from '@kilocode/web-shared/lib/tokens';
import { getUserOrgMemberships } from '@kilocode/web-shared/lib/organizations/organizations';
import {
  recordKiloAdminElevationForRequest,
  serviceTarget,
} from '@kilocode/web-shared/lib/admin/admin-access-log';
import { isWorkerAdminLegacyClaimIssuanceEnabled } from '@kilocode/web-shared/lib/config.server';
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
  const capabilityRequest =
    rawBody === null ? null : AdminCapabilityRequestSchema.safeParse(rawBody);
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
      await requireWorkerAdminActor(request, request.headers, {
        actionClass: 'worker_admin',
        target: { kind: 'service', id: 'wasteland' },
        inventoryId: 'rest.wastelandToken',
      });
      const issued = await issueWorkerAdminCapability({
        user,
        audience: WASTELAND_ADMIN_AUDIENCE,
        target,
        actions,
        headersList: request.headers,
      });
      return NextResponse.json({
        token,
        expiresAt,
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

  return NextResponse.json({ token, expiresAt });
}
