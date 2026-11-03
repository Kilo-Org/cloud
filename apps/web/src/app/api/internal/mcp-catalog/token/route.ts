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
 * Because the token carries that account's pepper and organization claims, the
 * identity is held to the same rules as the sibling bot-token mint: an
 * unblocked `bot-internal-*` bot user with a non-empty API-token pepper, holding
 * an owner or member role in the benchmarking organization. Anything else is
 * refused with 403 and mints nothing.
 *
 * The account is the benchmark worker's configured identity, not a hardcoded
 * default: production configures a dedicated service account. A saved config
 * with no override falls back to the contracts defaults. A worker error is
 * surfaced as 502 instead of masked by that fallback.
 *
 * URL: POST /api/internal/mcp-catalog/token
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { timingSafeEqual } from '@kilocode/encryption';
import { extractBearerToken } from '@kilocode/worker-utils/extract-bearer-token';
import { and, eq } from 'drizzle-orm';
import { resolveBenchmarkIdentity } from '@kilocode/auto-routing-contracts';
import { kilocode_users, organization_memberships } from '@kilocode/db/schema';
import { getBenchmarkConfig } from '@kilocode/web-shared/lib/ai-gateway/auto-routing-benchmark-admin-client';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { generateApiToken } from '@kilocode/web-shared/lib/tokens';
import { MCP_CATALOG_TOKEN_SECRET } from '@kilocode/web-shared/lib/config.server';
import {
  internalBotAccountIssue,
  isInternalBotOrganizationRole,
  type InternalBotAccountIssue,
} from '@/lib/bot-users/eligibility';

const ONE_HOUR_IN_SECONDS = 60 * 60;

const CATALOG_ACCOUNT_ISSUE_MESSAGES: Record<InternalBotAccountIssue, string> = {
  'not-an-internal-bot-id': 'the configured user id is not an internal bot user id',
  'not-a-bot': 'the account is not a bot user',
  blocked: 'the account is blocked',
  'missing-api-token-pepper': 'the account has no API token pepper',
};

/**
 * Resolve the service account the catalog dump runs as. The benchmark worker
 * owns the configured identity. A worker error is surfaced, not masked, so the
 * mint log names the real cause instead of the missing-default-user symptom. A
 * saved config with no override falls back to the contracts defaults, exactly
 * as the benchmark runner does.
 */
async function resolveCatalogServiceAccount(): Promise<
  { ok: true; userId: string; organizationId: string } | { ok: false; error: string }
> {
  let result: Awaited<ReturnType<typeof getBenchmarkConfig>>;
  try {
    result = await getBenchmarkConfig();
  } catch (error) {
    return {
      ok: false,
      error: `the benchmark worker is unreachable (${
        error instanceof Error ? error.message : String(error)
      })`,
    };
  }
  if (result.status !== 200) {
    const detail = 'error' in result.body ? result.body.error : `HTTP ${result.status}`;
    return { ok: false, error: `the benchmark worker returned ${detail}` };
  }
  const config = 'config' in result.body ? result.body.config : null;
  try {
    const identity = resolveBenchmarkIdentity(
      config ?? { benchmarkUserId: null, benchmarkOrgId: null }
    );
    return { ok: true, userId: identity.benchmarkUserId, organizationId: identity.benchmarkOrgId };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function POST(req: NextRequest) {
  const secret = extractBearerToken(req.headers.get('authorization'));
  if (!MCP_CATALOG_TOKEN_SECRET || !secret || !timingSafeEqual(secret, MCP_CATALOG_TOKEN_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const account = await resolveCatalogServiceAccount();
  if (!account.ok) {
    return NextResponse.json(
      { error: `Cannot resolve the catalog service account: ${account.error}` },
      { status: 502 }
    );
  }
  const { userId, organizationId } = account;

  const [user] = await db
    .select()
    .from(kilocode_users)
    .where(eq(kilocode_users.id, userId))
    .limit(1);

  if (!user) {
    return NextResponse.json({ error: 'Benchmark service account not found' }, { status: 404 });
  }

  // The token carries the account's pepper and organization claims, so the
  // account must be the dedicated internal bot the route documents, under the
  // same rules the sibling bot-token mint applies. A mis-set worker config then
  // fails here with a clear reason instead of minting for whatever it names.
  const accountIssue = internalBotAccountIssue(user);
  if (accountIssue !== null) {
    return NextResponse.json(
      {
        error: `Benchmark service account is not usable: ${CATALOG_ACCOUNT_ISSUE_MESSAGES[accountIssue]}`,
      },
      { status: 403 }
    );
  }

  const [membership] = await db
    .select({ role: organization_memberships.role })
    .from(organization_memberships)
    .where(
      and(
        eq(organization_memberships.kilo_user_id, userId),
        eq(organization_memberships.organization_id, organizationId)
      )
    )
    .limit(1);

  if (!membership) {
    return NextResponse.json(
      { error: 'Benchmark organization membership not found' },
      { status: 404 }
    );
  }

  if (!isInternalBotOrganizationRole(membership.role)) {
    return NextResponse.json(
      { error: 'Benchmark service account organization role is not supported' },
      { status: 403 }
    );
  }

  const organizationRole = membership.role;
  const apiToken = generateApiToken(
    user,
    {
      tokenSource: 'mcp-catalog',
      organizationId,
      organizationRole,
    },
    { expiresIn: ONE_HOUR_IN_SECONDS }
  );

  return NextResponse.json({
    token: apiToken,
    userId,
    organizationId,
    expiresAt: new Date(Date.now() + ONE_HOUR_IN_SECONDS * 1000).toISOString(),
  });
}
