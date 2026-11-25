import {
  KILO_EXA_SEARCH_AUDIENCE,
  KILO_INFERENCE_AUDIENCE,
} from './internal-service-token-audiences';
import { signModernKiloToken, verifyKiloTokenForPolicy } from './kilo-token-policy';

type InstanceIdentity = {
  userId: string;
  organizationId: string | null;
  secret: string;
  env?: string;
};

export function signKiloClawInferenceToken(params: InstanceIdentity & { pepper: string | null }) {
  return signModernKiloToken({
    ...params,
    expiresInSeconds: 30 * 24 * 60 * 60,
    audience: KILO_INFERENCE_AUDIENCE,
    tokenPurpose: 'delegated-workload',
    credentialExchange: false,
    extra: { organizationId: params.organizationId ?? undefined },
  });
}

/** Verify before delivering a persisted key: never fall back to a legacy or multi-audience JWT. */
export async function verifyKiloClawInferenceToken(token: string, instance: InstanceIdentity) {
  const { claims } = await verifyKiloTokenForPolicy(token, instance.secret, {
    audience: KILO_INFERENCE_AUDIENCE,
    mode: 'required',
  });
  if (
    claims.aud !== KILO_INFERENCE_AUDIENCE ||
    claims.tokenPurpose !== 'delegated-workload' ||
    claims.credentialExchange !== false ||
    claims.kiloUserId !== instance.userId ||
    (claims.organizationId ?? null) !== instance.organizationId ||
    claims.apiTokenPepper === undefined ||
    (instance.env && claims.env !== instance.env)
  ) {
    throw new Error('Stored credential does not match the KiloClaw instance');
  }
  return claims;
}

/** The control plane issues an independent, co-expiring key for the bundled search plugin. */
export async function signKiloClawSearchToken(token: string, instance: InstanceIdentity) {
  const claims = await verifyKiloClawInferenceToken(token, instance);
  return signModernKiloToken({
    ...instance,
    pepper: claims.apiTokenPepper,
    now: new Date(claims.iat * 1000),
    expiresInSeconds: claims.exp - claims.iat,
    audience: KILO_EXA_SEARCH_AUDIENCE,
    tokenPurpose: 'delegated-workload',
    credentialExchange: false,
    extra: { organizationId: instance.organizationId ?? undefined },
  });
}
