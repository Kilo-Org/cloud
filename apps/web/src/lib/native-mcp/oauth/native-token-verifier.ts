import 'server-only';
import jwt from 'jsonwebtoken';
import { and, eq, isNull } from 'drizzle-orm';
import {
  GatewayErrorCode,
  GatewayMcpAccessScope,
  NativeMcpTokenClaimsSchema,
  createGatewayError,
  nativeMcpResourceUrl,
  parseScopeString,
} from '@kilocode/mcp-gateway';
import { kilocode_users, type User } from '@kilocode/db/schema';
import { readDb, type db } from '@/lib/drizzle';
import { getGatewayAppConfig, type GatewayAppConfig } from '@/lib/mcp-gateway/config';
import { verificationKey } from '@/lib/mcp-gateway/token-service';

type Database = typeof db;

export async function findEligibleNativeMcpUser(
  userId: string,
  database: Database = readDb
): Promise<User | null> {
  const [row] = await database
    .select({ user: kilocode_users })
    .from(kilocode_users)
    .where(
      and(
        eq(kilocode_users.id, userId),
        isNull(kilocode_users.blocked_reason),
        isNull(kilocode_users.blocked_at),
        eq(kilocode_users.is_bot, false),
        eq(kilocode_users.is_admin, true)
      )
    )
    .limit(1);
  return row?.user ?? null;
}

export async function verifyNativeMcpBearerToken(params: {
  token: string;
  config?: GatewayAppConfig;
  database?: Database;
}) {
  const config = params.config ?? getGatewayAppConfig();
  const resourceUrl = nativeMcpResourceUrl(config.appBaseUrl);
  const decoded = jwt.decode(params.token, { complete: true });
  const kid = decoded && typeof decoded === 'object' ? decoded.header.kid : undefined;
  if (!kid) {
    throw createGatewayError(GatewayErrorCode.InvalidGrant, 'Token key ID is missing', 401);
  }
  const key = config.jwtKeyset.keys.find(candidate => candidate.keyId === kid);
  if (!key) {
    throw createGatewayError(GatewayErrorCode.InvalidGrant, 'Token key is unknown', 401);
  }
  const payload = jwt.verify(params.token, verificationKey(key), {
    algorithms: ['RS256'],
    issuer: config.issuer,
    audience: resourceUrl,
  });
  if (typeof payload === 'string') {
    throw createGatewayError(GatewayErrorCode.InvalidGrant, 'Token payload is malformed', 401);
  }
  const claims = NativeMcpTokenClaimsSchema.parse(payload);
  if (!parseScopeString(claims.scope).includes(GatewayMcpAccessScope)) {
    throw createGatewayError(GatewayErrorCode.InvalidScope, 'mcp:access scope is required', 403);
  }
  const user = await findEligibleNativeMcpUser(claims.sub, params.database ?? readDb);
  if (!user) {
    throw createGatewayError(GatewayErrorCode.Forbidden, 'Native MCP access is unavailable', 403);
  }
  return { claims, user };
}

export function createNativeMcpTokenVerifier(
  params: {
    config?: GatewayAppConfig;
    database?: Database;
  } = {}
) {
  return {
    verify: (token: string) =>
      verifyNativeMcpBearerToken({ token, config: params.config, database: params.database }),
  };
}
