import { KILO_API_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import { KILO_TOKEN_VERSION, kiloTokenPayload } from '@kilocode/worker-utils/kilo-token';
import { isKiloResourceAudienceAllowed } from '@kilocode/worker-utils/kilo-token-policy';
import { isKiloTokenAdmissionObservationEnabled } from '@kilocode/worker-utils/kilo-token-admission-observation';
import { observeWebBearerAdmission } from '@kilocode/web-shared/lib/kilo-token-admission';
import { CloudAgentNextRuntimeAuthorizationClaimSchema } from '@kilocode/worker-utils/runtime-proxy-attestation';
import {
  isCloudAgentAuthorityHttpPathAllowed,
  validateCloudAgentAuthorityClaims,
  type CloudAgentAuthority,
} from '@kilocode/worker-utils/cloud-agent-authority';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { NEXTAUTH_SECRET } from '@kilocode/web-shared/lib/config.server';

/**
 * @deprecated Use `KILO_TOKEN_VERSION`. One test file outside this change holds
 * the only remaining caller, so the name stays until that file moves.
 */
export { KILO_TOKEN_VERSION as JWT_TOKEN_VERSION } from '@kilocode/worker-utils/kilo-token';

const jwtSigningAlgorithm = 'HS256';

/**
 * The bearer a Kilo client sends when nobody is signed in.
 *
 * The clients set `apiKey: "anonymous"` rather than omitting the header
 * (`ANONYMOUS_API_KEY` in `packages/kilo-gateway/src/api/constants.ts` of the
 * kilocode repository), so the header arrives present and its value is not a
 * token. It means "no credential", not "a credential that failed", and must be
 * treated as the former. Delete this constant once no released client sends it.
 */
const ANONYMOUS_BEARER_SENTINEL = 'anonymous';

/**
 * The claims a verified Kilo bearer carries, taken from the shared payload
 * schema so the claim list has one source.
 *
 * `version` is widened to any number: the version refusal must stay reachable
 * for a token issued by an older version. The object is loose because
 * `validateCloudAgentAuthorityClaims` strict-parses the claim set and denies any
 * claim name it does not know.
 */
const kiloTokenClaims = z.looseObject({
  ...kiloTokenPayload.omit({ version: true }).shape,
  version: z.number(),
  /**
   * The audience stays unvalidated. `isKiloResourceAudienceAllowed` owns the
   * audience refusal and its tolerance for legacy, null, blank and array
   * audiences.
   */
  aud: z.unknown().optional(),
});

/** Claims an issued Kilo token carries; the schema is the single source. */
export type JWTTokenPayload = z.infer<typeof kiloTokenClaims>;

export type JWTTokenExtraPayload = Pick<
  JWTTokenPayload,
  | 'deviceAuthRequestCode'
  | 'deviceSessionId'
  | 'botId'
  | 'organizationId'
  | 'organizationRole'
  | 'internalApiUse'
  | 'isAdmin'
  | 'createdOnPlatform'
  | 'tokenSource'
  | 'orgMemberships'
>;

function tryJwtVerify(token: string) {
  try {
    const verified = jwt.verify(token, NEXTAUTH_SECRET, {
      algorithms: [jwtSigningAlgorithm],
    });
    const parsed = kiloTokenClaims.safeParse(verified);
    if (!parsed.success) {
      warnExceptInTest('Token payload does not match the Kilo token schema:', parsed.error);
      return null;
    }
    return parsed.data;
  } catch (error) {
    warnExceptInTest('Token verification failed:', error);
    return null;
  }
}

/**
 * The one refusal reason that may continue anonymously: the request presented no
 * credential at all.
 *
 * Every other reason means the caller presented a credential that could not be
 * accepted — `invalid_token`, `token_version_outdated`,
 * `runtime_attestation_required`, or a valid token sent to an endpoint it is not
 * scoped for (`audience_not_allowed`). Such a request must not be answered as an
 * anonymous caller. The caller believes it is authenticated, so downgrading it
 * silently drops the account, its organization, its BYOK keys and its credits,
 * and hides the broken credential from the client that sent it.
 */
const ANONYMOUS_FALL_THROUGH_REASON = 'missing_credentials';

/**
 * True when the request presented a credential that failed verification, rather
 * than presenting none.
 *
 * Fails closed. Only `missing_credentials` returns false, so a reason added to
 * `validateAuthorizationHeader` later — or a failure that carries no reason at
 * all — counts as a rejected credential.
 */
export function isRejectedCredentialReason(reason: string | undefined): boolean {
  return reason !== ANONYMOUS_FALL_THROUGH_REASON;
}

type AuthorizationHeaderOptions = {
  expectedAudience?: string;
  runtimeProxyAttestationVerified?: boolean;
  // Derive from an actual Request URL or fixed route path, never a request header.
  requestPathname?: string;
  /**
   * Set only by the request's admission point (`getUserFromAuth`), so a
   * second read of the same header, such as the gateway rate-limit key,
   * does not report the decision twice.
   */
  observeAdmission?: boolean;
};

export function validateAuthorizationHeader(
  headers: Headers,
  options?: AuthorizationHeaderOptions
) {
  const authHeader = headers.get('authorization');
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    warnExceptInTest('Authorization header missing or invalid');
    return {
      error: 'Unauthorized - authentication required',
      reason: ANONYMOUS_FALL_THROUGH_REASON,
    };
  }

  const token = authHeader.substring(7);

  if (token === ANONYMOUS_BEARER_SENTINEL) {
    return {
      error: 'Unauthorized - authentication required',
      reason: ANONYMOUS_FALL_THROUGH_REASON,
    };
  }

  const payload = tryJwtVerify(token);

  if (!payload) {
    const traceability_logging_id = crypto.randomUUID();
    warnExceptInTest(`Invalid token (${traceability_logging_id})`);
    return {
      error: `Invalid token (${traceability_logging_id})`,
      reason: 'invalid_token',
    };
  }

  const policyAudience = options?.expectedAudience ?? KILO_API_AUDIENCE;
  const result = admitVerifiedToken(payload, policyAudience, options);
  if (options?.observeAdmission === true && isKiloTokenAdmissionObservationEnabled()) {
    observeWebBearerAdmission(headers, payload, policyAudience, result.reason ?? 'admitted');
  }
  return result;
}

/** Every check after the signature; the result is the caller's verdict. */
function admitVerifiedToken(
  payload: JWTTokenPayload,
  policyAudience: string,
  options: AuthorizationHeaderOptions | undefined
) {
  if (
    !isKiloResourceAudienceAllowed(payload.aud, { audience: policyAudience, mode: 'allow-legacy' })
  ) {
    const traceability_logging_id = crypto.randomUUID();
    warnExceptInTest(`Invalid token (${traceability_logging_id})`);
    return {
      error: `Invalid token (${traceability_logging_id})`,
      reason: 'audience_not_allowed',
    };
  }

  if (payload.version !== KILO_TOKEN_VERSION) {
    const traceability_logging_id = crypto.randomUUID();
    warnExceptInTest(`Token version outdated (${traceability_logging_id}):`, {
      version: payload.version,
      kiloUserId: payload.kiloUserId,
    });
    return {
      error: `Token version outdated, please re-authenticate (${traceability_logging_id})`,
      reason: 'token_version_outdated',
    };
  }

  let cloudAgentAuthority: CloudAgentAuthority | undefined;
  if (Object.hasOwn(payload, 'cloudAgentAuthority')) {
    try {
      cloudAgentAuthority = validateCloudAgentAuthorityClaims(payload);
      if (
        payload.env !== process.env.NODE_ENV ||
        typeof payload.iat !== 'number' ||
        payload.iat > Math.floor(Date.now() / 1000) ||
        !isCloudAgentAuthorityHttpPathAllowed(cloudAgentAuthority, options?.requestPathname)
      ) {
        throw new Error('Cloud Agent authority is not allowed on this request');
      }
    } catch {
      return { error: 'Invalid scoped API token', reason: 'cloud_agent_authority_denied' };
    }
  }

  // Only the Cloud Agent runtime credential proxy can attest this claim, so a
  // verified one proves the request came through that proxy.
  let cloudAgentRuntimeProxied = false;
  if (
    typeof payload.runtimeAuthorization === 'object' &&
    payload.runtimeAuthorization !== null &&
    'resourceKind' in payload.runtimeAuthorization &&
    payload.runtimeAuthorization.resourceKind === 'cloud-agent-next'
  ) {
    const runtimeAuthorization = CloudAgentNextRuntimeAuthorizationClaimSchema.safeParse(
      payload.runtimeAuthorization
    );
    if (!runtimeAuthorization.success || !options?.runtimeProxyAttestationVerified) {
      const traceability_logging_id = crypto.randomUUID();
      warnExceptInTest(`Invalid token (${traceability_logging_id})`);
      return {
        error: `Invalid token (${traceability_logging_id})`,
        reason: 'runtime_attestation_required',
      };
    }
    cloudAgentRuntimeProxied = true;
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
    cloudAgentAuthority,
    cloudAgentRuntimeProxied,
  };
}
