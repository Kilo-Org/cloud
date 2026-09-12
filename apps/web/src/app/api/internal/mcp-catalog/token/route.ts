/**
 * Internal API: mint a short-lived Kilo API token for the MCP catalog dump.
 *
 * Called by `.github/workflows/kilo-mcp-catalog.yml`. The catalog dump shells
 * out to `kilo run` to generate missing search summaries, and the CLI
 * authenticates against the gateway with a user API token. The workflow holds
 * `MCP_CATALOG_TOKEN_SECRET`, a shared secret whose only purpose is this mint,
 * and exchanges it for a token that belongs to the benchmarking service
 * account instead of a maintainer's personal login.
 *
 * The minted token is a full user API token (includes `apiTokenPepper`) so the
 * gateway accepts it as a real user token. It expires in 1 hour — a single
 * catalog dump run — and is scoped to the benchmarking organization.
 *
 * URL: POST /api/internal/mcp-catalog/token
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { timingSafeEqual } from '@kilocode/encryption';
import { extractBearerToken } from '@kilocode/worker-utils/extract-bearer-token';
import { and, eq } from 'drizzle-orm';
import {
  DEFAULT_BENCHMARK_ORG_ID,
  DEFAULT_BENCHMARK_USER_ID,
} from '@kilocode/auto-routing-contracts';
import { kilocode_users, organization_memberships } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { generateApiToken } from '@/lib/tokens';
import { MCP_CATALOG_TOKEN_SECRET } from '@/lib/config.server';

const ONE_HOUR_IN_SECONDS = 60 * 60;

export async function POST(req: NextRequest) {
  const secret = extractBearerToken(req.headers.get('authorization'));
  if (!MCP_CATALOG_TOKEN_SECRET || !secret || !timingSafeEqual(secret, MCP_CATALOG_TOKEN_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const [user] = await db
    .select()
    .from(kilocode_users)
    .where(eq(kilocode_users.id, DEFAULT_BENCHMARK_USER_ID))
    .limit(1);

  if (!user) {
    return NextResponse.json({ error: 'Benchmark service account not found' }, { status: 404 });
  }

  const [membership] = await db
    .select({ role: organization_memberships.role })
    .from(organization_memberships)
    .where(
      and(
        eq(organization_memberships.kilo_user_id, DEFAULT_BENCHMARK_USER_ID),
        eq(organization_memberships.organization_id, DEFAULT_BENCHMARK_ORG_ID)
      )
    )
    .limit(1);

  if (!membership) {
    return NextResponse.json(
      { error: 'Benchmark organization membership not found' },
      { status: 404 }
    );
  }

  const apiToken = generateApiToken(
    user,
    {
      tokenSource: 'mcp-catalog',
      organizationId: DEFAULT_BENCHMARK_ORG_ID,
      organizationRole: membership.role,
    },
    { expiresIn: ONE_HOUR_IN_SECONDS }
  );

  return NextResponse.json({
    token: apiToken,
    organizationId: DEFAULT_BENCHMARK_ORG_ID,
    expiresAt: new Date(Date.now() + ONE_HOUR_IN_SECONDS * 1000).toISOString(),
  });
}
