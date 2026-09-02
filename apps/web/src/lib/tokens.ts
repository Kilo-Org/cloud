import type { User } from '@kilocode/db/schema';
import {
  BITBUCKET_CODE_REVIEW_PULL_REQUEST_AUDIENCE,
  BITBUCKET_CODE_REVIEW_WEBHOOK_DELETE_AUDIENCE,
  BITBUCKET_CODE_REVIEW_WEBHOOK_ENSURE_AUDIENCE,
  BITBUCKET_REPOSITORY_LIST_AUDIENCE,
  GITHUB_USER_ACCESS_TOKEN_AUDIENCE,
  GITHUB_USER_AUTHORIZATION_DISCONNECT_AUDIENCE,
  GITLAB_CREDENTIAL_BROKER_AUDIENCE,
  SESSION_INGEST_AUDIENCE,
  SESSION_INGEST_USER_DELETION_AUDIENCE,
  USER_DATA_EXPORT_AUDIENCE,
} from '@kilocode/worker-utils/internal-service-token-audiences';
import { buildModernKiloTokenPayload } from '@kilocode/worker-utils/kilo-token-policy';
import type { OrganizationRole } from '@/lib/organizations/organization-types';
import jwt from 'jsonwebtoken';
import { warnExceptInTest } from '@/lib/utils.server';
import { isBoundedInternalServiceTokenIssuanceEnabled, NEXTAUTH_SECRET } from '@/lib/config.server';

export { BITBUCKET_REPOSITORY_LIST_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';

export const JWT_TOKEN_VERSION = 3;

const jwtSigningAlgorithm = 'HS256';

export const BOUNDED_INTERNAL_SERVICE_AUDIENCES = [
  BITBUCKET_REPOSITORY_LIST_AUDIENCE,
  BITBUCKET_CODE_REVIEW_PULL_REQUEST_AUDIENCE,
  BITBUCKET_CODE_REVIEW_WEBHOOK_ENSURE_AUDIENCE,
  BITBUCKET_CODE_REVIEW_WEBHOOK_DELETE_AUDIENCE,
  GITLAB_CREDENTIAL_BROKER_AUDIENCE,
  GITHUB_USER_ACCESS_TOKEN_AUDIENCE,
  GITHUB_USER_AUTHORIZATION_DISCONNECT_AUDIENCE,
  USER_DATA_EXPORT_AUDIENCE,
  SESSION_INGEST_USER_DELETION_AUDIENCE,
  SESSION_INGEST_AUDIENCE,
] as const;

export type BoundedInternalServiceAudience = (typeof BOUNDED_INTERNAL_SERVICE_AUDIENCES)[number];

const boundedInternalServiceAudienceSet: ReadonlySet<string> = new Set(
  BOUNDED_INTERNAL_SERVICE_AUDIENCES
);

export type JWTTokenExtraPayload = {
  deviceAuthRequestCode?: string;
  deviceSessionId?: string;
  botId?: string;
  organizationId?: string;
  organizationRole?: OrganizationRole;
  internalApiUse?: boolean;
  isAdmin?: boolean;
  gastownAccess?: boolean;
  createdOnPlatform?: string;
  tokenSource?: string;
  orgMemberships?: Array<{ orgId: string; role: OrganizationRole }>;
};

const FIVE_YEARS_IN_SECONDS = 5 * 365 * 24 * 60 * 60;
const THIRTY_DAYS_IN_SECONDS = 30 * 24 * 60 * 60;
const ONE_HOUR_IN_SECONDS = 60 * 60;
const FIVE_MINUTES_IN_SECONDS = 5 * 60;

export const TOKEN_EXPIRY = {
  default: FIVE_YEARS_IN_SECONDS,
  thirtyDays: THIRTY_DAYS_IN_SECONDS,
  oneHour: ONE_HOUR_IN_SECONDS,
  fiveMinutes: FIVE_MINUTES_IN_SECONDS,
} as const;

/**
 * Generate a short-lived JWT for authenticating with internal Cloudflare Worker services
 * (e.g. session-ingest). Contains only the minimal fields the workers require:
 * kiloUserId and version. Defaults to a 1-hour expiry.
 */
export function generateInternalServiceToken(
  userId: string,
  options?: { expiresIn?: number; audience?: string; organizationId?: string }
): string {
  return jwt.sign(
    {
      kiloUserId: userId,
      version: JWT_TOKEN_VERSION,
      ...(options?.organizationId ? { organizationId: options.organizationId } : {}),
    },
    NEXTAUTH_SECRET,
    {
      algorithm: jwtSigningAlgorithm,
      expiresIn: options?.expiresIn ?? ONE_HOUR_IN_SECONDS,
      ...(options?.audience ? { audience: options.audience } : {}),
    }
  );
}

export function generateBoundedInternalServiceToken(
  userId: string,
  options: {
    audience: BoundedInternalServiceAudience;
    expiresIn: number;
    organizationId?: string;
  }
): string {
  if (!boundedInternalServiceAudienceSet.has(options.audience)) {
    throw new Error('Unsupported bounded internal service token audience');
  }
  const maximumLifetime =
    options.audience === SESSION_INGEST_AUDIENCE ? ONE_HOUR_IN_SECONDS : FIVE_MINUTES_IN_SECONDS;
  if (options.expiresIn > maximumLifetime) {
    throw new Error('Bounded internal service token lifetime exceeds its audience limit');
  }

  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = buildModernKiloTokenPayload({
    userId,
    audience: options.audience,
    issuedAt,
    expiresAt: issuedAt + options.expiresIn,
    tokenPurpose: 'internal-service',
    credentialExchange: false,
    extra: options.organizationId ? { organizationId: options.organizationId } : undefined,
  });

  if (isBoundedInternalServiceTokenIssuanceEnabled()) {
    return jwt.sign(payload, NEXTAUTH_SECRET, { algorithm: jwtSigningAlgorithm });
  }

  return generateInternalServiceToken(userId, {
    expiresIn: options.expiresIn,
    audience:
      options.audience === SESSION_INGEST_AUDIENCE ||
      options.audience === GITHUB_USER_AUTHORIZATION_DISCONNECT_AUDIENCE
        ? undefined
        : options.audience,
    organizationId: options.organizationId,
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
  const authHeader = headers.get('authorization');
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    warnExceptInTest('Authorization header missing or invalid');
    return { error: 'Unauthorized - authentication required' };
  }

  const token = authHeader.substring(7);
  const payload = tryJwtVerify(token);

  if (!payload) {
    warnExceptInTest(`Invalid token (${traceability_logging_id})`);
    return { error: `Invalid token (${traceability_logging_id})` };
  }

  if (payload.version != JWT_TOKEN_VERSION) {
    warnExceptInTest(`Token version outdated (${traceability_logging_id}):`, {
      version: payload.version,
      kiloUserId: payload.kiloUserId,
    });
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
    tokenSource: payload.tokenSource,
    deviceSessionId: payload.deviceSessionId,
  };
}

export function generateCloudAgentToken(user: User) {
  return generateApiToken(user, { tokenSource: 'cloud-agent' });
}
