import type { User } from '@/db/schema';
import type { OrganizationRole } from '@/lib/organizations/organization-types';
import jwt from 'jsonwebtoken';
import { logExceptInTest, warnExceptInTest } from '@/lib/utils.server';
import { NEXTAUTH_SECRET } from '@/lib/config.server';

export const JWT_TOKEN_VERSION = 3;
const jwtSigningAlgorithm = 'HS256';

export type JWTTokenExtraPayload = {
  deviceAuthRequestCode?: string;
  botId?: string;
  organizationId?: string;
  organizationRole?: OrganizationRole;
  internalApiUse?: boolean;
  createdOnPlatform?: string;
};

const FIVE_YEARS_IN_SECONDS = 5 * 365 * 24 * 60 * 60;
const THIRTY_DAYS_IN_SECONDS = 30 * 24 * 60 * 60;
const FIVE_MINUTES_IN_SECONDS = 5 * 60;

export const TOKEN_EXPIRY = {
  default: FIVE_YEARS_IN_SECONDS,
  thirtyDays: THIRTY_DAYS_IN_SECONDS,
  fiveMinutes: FIVE_MINUTES_IN_SECONDS,
} as const;

/**
 * Generate a short-lived JWT for authenticating with internal Cloudflare Worker services
 * (e.g. session-ingest). Contains only the minimal fields the workers require:
 * kiloUserId and version. Expires in 1 hour.
 */
export function generateInternalServiceToken(userId: string): string {
  return jwt.sign({ kiloUserId: userId, version: JWT_TOKEN_VERSION }, NEXTAUTH_SECRET, {
    algorithm: jwtSigningAlgorithm,
    expiresIn: '1h',
  });
}

export function generateApiToken(
  { id, api_token_pepper }: User,
  extraPayload?: JWTTokenExtraPayload,
  options?: { expiresIn?: number }
) {
  return jwt.sign(
    {
      env: process.env.NODE_ENV,
      kiloUserId: id,
      apiTokenPepper: api_token_pepper,
      version: JWT_TOKEN_VERSION,
      ...extraPayload,
    },
    NEXTAUTH_SECRET,
    {
      algorithm: jwtSigningAlgorithm,
      expiresIn: options?.expiresIn ?? FIVE_YEARS_IN_SECONDS,
    }
  );
}

export function generateOrganizationApiToken(
  user: User,
  organizationId: string,
  organizationRole: OrganizationRole
) {
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes from now

  const token = jwt.sign(
    {
      env: process.env.NODE_ENV,
      kiloUserId: user.id,
      apiTokenPepper: user.api_token_pepper,
      version: JWT_TOKEN_VERSION,
      organizationId,
      organizationRole,
    },
    NEXTAUTH_SECRET,
    {
      algorithm: jwtSigningAlgorithm,
      expiresIn: '15m',
    }
  );

  return {
    token,
    expiresAt: expiresAt.toISOString(),
  };
}

export type JWTTokenPayload = {
  kiloUserId: string;
  version: number;
  apiTokenPepper?: string;
} & JWTTokenExtraPayload;

function tryJwtVerify(token: string) {
  try {
    const payload = jwt.verify(token, NEXTAUTH_SECRET, {
      algorithms: [jwtSigningAlgorithm],
    }) as jwt.JwtPayload & JWTTokenPayload;
    return payload;
  } catch (error) {
    warnExceptInTest('Token verification failed:', error);
    return null;
  }
}

export function validateAuthorizationHeader(headers: Headers) {
  const traceability_logging_id = crypto.randomUUID();
  if (process.env.NODE_ENV !== 'development') {
    logExceptInTest(`headers (${traceability_logging_id})`, Object.fromEntries(headers.entries()));
  }

  const authHeader = headers.get('authorization');
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    warnExceptInTest('Authorization header missing or invalid');
    return { error: 'Unauthorized - authentication required' };
  }

  const token = authHeader.substring(7);
  const payload = tryJwtVerify(token);

  if (!payload) {
    warnExceptInTest(`Invalid token (${traceability_logging_id}):`, { token });
    return { error: `Invalid token (${traceability_logging_id})` };
  }

  if (payload.version != JWT_TOKEN_VERSION) {
    warnExceptInTest(`Token version outdated (${traceability_logging_id}):`, payload);
    return { error: `Token version outdated, please re-authenticate (${traceability_logging_id})` };
  }

  return {
    kiloUserId: payload.kiloUserId,
    apiTokenPepper: payload.apiTokenPepper,
    organizationId: payload.organizationId,
    organizationRole: payload.organizationRole,
    internalApiUse: payload.internalApiUse,
    createdOnPlatform: payload.createdOnPlatform,
    botId: payload.botId,
  };
}
