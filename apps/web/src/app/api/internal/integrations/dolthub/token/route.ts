/**
 * Internal API: fresh DoltHub access token for a given owner.
 *
 * Called by:
 * - services/wasteland (cloudflare-wasteland) — every wanted-board op needs
 *   a non-expired DoltHub OAuth access token to talk to the DoltHub REST
 *   API. Wasteland used to keep its own encrypted snapshot of the access
 *   token; that copy went stale once OAuth tokens rotated. This endpoint
 *   makes the web app the single source of truth for the token, with
 *   automatic refresh via `getValidDoltHubToken`.
 *
 * Auth: shared `INTERNAL_API_SECRET` over `X-Internal-Secret` header
 * (same pattern as other `/api/internal/...` routes — see
 * `apps/web/src/app/api/internal/triage/post-comment/route.ts`).
 *
 * URL: POST /api/internal/integrations/dolthub/token
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { INTERNAL_API_SECRET } from '@/lib/config.server';
import * as dolthubService from '@/lib/integrations/dolthub-service';
import { INTEGRATION_STATUS } from '@/lib/integrations/core/constants';

const RequestSchema = z
  .object({
    userId: z.string().min(1).optional(),
    organizationId: z.string().min(1).optional(),
  })
  .refine(v => Boolean(v.userId) !== Boolean(v.organizationId), {
    message: 'Provide exactly one of userId or organizationId',
  });

export async function POST(req: NextRequest) {
  const secret = req.headers.get('X-Internal-Secret');
  if (!INTERNAL_API_SECRET || secret !== INTERNAL_API_SECRET) {
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

  const owner = parsed.data.userId
    ? ({ type: 'user', id: parsed.data.userId } as const)
    : ({ type: 'org', id: parsed.data.organizationId! } as const);

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

  return NextResponse.json({
    token,
    dolthubUsername: dolthubService.getCachedDoltHubUsername(integration),
  });
}
