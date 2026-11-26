/**
 * The WebAuthn related-origins document that `/.well-known/webauthn` serves (design 5.14, Q37).
 *
 * Passkeys bind to the app host: `passkey.ts` takes the relying-party id from `NEXTAUTH_URL`,
 * which is `APP_URL`. The UTS sign-in pages run on their own origin with that same relying-party
 * id (`WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGINS` in `services/uts/wrangler.jsonc`). A browser lets
 * those pages use the app host's passkeys only when this document, fetched from the app host,
 * lists the UTS origin.
 *
 * Each environment lists only its own UTS origin. The entry comes from the deployment's own
 * configuration and Vercel's environment, never from the request: the request host can only
 * refuse. A preview, a development server, a deployment URL or any other host gets no document.
 */
const RELATED_ORIGINS = [
  {
    environment: 'production',
    appOrigin: 'https://app.kilo.ai',
    utsOrigin: 'https://uts.kiloapps.io',
  },
  {
    environment: 'staging',
    appOrigin: 'https://staging-app.kilo.ai',
    utsOrigin: 'https://uts-staging.kiloapps.io',
  },
] as const;

export type RelatedOriginsInput = {
  /** `APP_URL`: the configured app origin, which names the passkey relying party. */
  appUrl: string;
  vercelEnv: string | undefined;
  vercelTargetEnv: string | undefined;
  /** The request's `Host` header. */
  requestHost: string | null;
};

export type RelatedOriginsDocument = { origins: [string] };

// The same deployment checks as `isStagingDeployment` (`@kilocode/web-shared/lib/constants`) and
// the production check in `processUsage.ts`, read from arguments instead of `process.env`.
function deploymentEnvironment(
  vercelEnv: string | undefined,
  vercelTargetEnv: string | undefined
): 'production' | 'staging' | null {
  if (vercelEnv === 'production' && vercelTargetEnv === 'production') return 'production';
  if (vercelTargetEnv === 'staging' && vercelEnv !== 'production') return 'staging';
  return null;
}

export function webAuthnRelatedOrigins({
  appUrl,
  vercelEnv,
  vercelTargetEnv,
  requestHost,
}: RelatedOriginsInput): RelatedOriginsDocument | null {
  const environment = deploymentEnvironment(vercelEnv, vercelTargetEnv);
  const entry = RELATED_ORIGINS.find(
    candidate => candidate.environment === environment && candidate.appOrigin === appUrl
  );
  if (!entry || requestHost !== new URL(entry.appOrigin).host) return null;
  return { origins: [entry.utsOrigin] };
}
