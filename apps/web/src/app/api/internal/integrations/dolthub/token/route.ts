/**
 * Internal API: fresh DoltHub access token for a user.
 *
 * Called by:
 * - services/wasteland (cloudflare-wasteland) — every wanted-board op needs
 *   a non-expired DoltHub OAuth access token to talk to the DoltHub REST
 *   API. Wasteland used to keep its own encrypted snapshot of the access
 *   token; that copy went stale once OAuth tokens rotated. This endpoint
 *   makes the web app the single source of truth for the token, with
 *   automatic refresh via `getValidDoltHubToken`.
 *
 * Auth: only `WASTELAND_DOLTHUB_TOKEN_SECRET`, the Wasteland-only caller
 * credential, sent as `Authorization: Bearer <secret>` and compared with
 * `timingSafeEqual`. The response is a third-party OAuth credential, so the
 * route has a credential of its own that only the service acting for the
 * owning user holds. Unset or empty disables the route.
 *
 * Only a user owner is accepted. Organization-owned DoltHub integrations are
 * read by the web app for the signed-in member directly; no internal caller
 * acts for an organization.
 *
 * Every issuance is logged with the owner it was issued for. The token and
 * the cached username never appear in logs.
 *
 * URL: POST /api/internal/integrations/dolthub/token
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { timingSafeEqual } from '@kilocode/encryption';
import { extractBearerToken } from '@kilocode/worker-utils/extract-bearer-token';
import { WASTELAND_DOLTHUB_TOKEN_SECRET } from '@kilocode/web-shared/lib/config.server';
import * as dolthubService from '@/lib/integrations/dolthub-service';
import { INTEGRATION_STATUS } from '@/lib/integrations/core/constants';

const CALLER = 'wasteland';

const RequestSchema = z.object({ userId: z.string().min(1) }).strict();

export async function POST(req: NextRequest) {
  const secret = extractBearerToken(req.headers.get('authorization'));
  if (
    !WASTELAND_DOLTHUB_TOKEN_SECRET ||
    !secret ||
    !timingSafeEqual(secret, WASTELAND_DOLTHUB_TOKEN_SECRET)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const owner = { type: 'user', id: parsed.data.userId } as const;

  const integration = await dolthubService.getInstallation(owner);
  if (!integration) {
    return NextResponse.json({ error: 'DoltHub integration not installed' }, { status: 404 });
  }
  if (integration.integration_status !== INTEGRATION_STATUS.ACTIVE) {
    return NextResponse.json({ error: 'DoltHub integration not active' }, { status: 409 });
  }

  let token: string | null;
  try {
    token = await dolthubService.getValidDoltHubToken(integration);
  } catch (err) {
    return NextResponse.json(
      {
        error: 'Failed to refresh DoltHub access token',
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 502 }
    );
  }

  if (!token) {
    return NextResponse.json(
      { error: 'No usable DoltHub access token (refresh required but no refresh_token stored)' },
      { status: 409 }
    );
  }

  console.info('[dolthub-internal-token] issued', {
    caller: CALLER,
    ownerType: owner.type,
    ownerId: owner.id,
    integrationId: integration.id,
  });

  return NextResponse.json({
    token,
    dolthubUsername: dolthubService.getCachedDoltHubUsername(integration),
  });
}
