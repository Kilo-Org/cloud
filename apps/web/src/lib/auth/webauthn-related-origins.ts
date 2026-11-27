/**
 * The WebAuthn related-origins document that `/.well-known/webauthn` serves (design 5.14, Q37).
 *
 * Passkeys bind to the app host: `passkey.ts` takes the relying-party id from `NEXTAUTH_URL`,
 * which is `APP_URL`. The production UTS sign-in pages run on their own origin with that same
 * relying-party id (`WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGINS` in `services/uts/wrangler.jsonc`). A
 * browser lets those pages use the app host's passkeys only when this document, fetched from the
 * app host, lists the UTS origin. Staging UTS uses its own relying party and needs no list.
 *
 * Only the production deployment on the production app host serves the document. The entry is
 * fixed here and checked against the deployment's own configuration and Vercel's environment,
 * never taken from the request: the request host can only refuse. Staging, a preview, a
 * development server, a deployment URL or any other host gets no document.
 */
const PRODUCTION_APP_ORIGIN = 'https://app.kilo.ai';
const PRODUCTION_APP_HOST = 'app.kilo.ai';
const PRODUCTION_UTS_ORIGIN = 'https://uts.kiloapps.io';

export type RelatedOriginsInput = {
  /** `APP_URL`: the configured app origin, which names the passkey relying party. */
  appUrl: string;
  vercelEnv: string | undefined;
  vercelTargetEnv: string | undefined;
  /** The request's `Host` header. */
  requestHost: string | null;
};

export type RelatedOriginsDocument = { origins: [string] };

// The same production check as `processUsage.ts`, read from arguments instead of `process.env`.
export function webAuthnRelatedOrigins({
  appUrl,
  vercelEnv,
  vercelTargetEnv,
  requestHost,
}: RelatedOriginsInput): RelatedOriginsDocument | null {
  if (vercelEnv !== 'production' || vercelTargetEnv !== 'production') return null;
  if (appUrl !== PRODUCTION_APP_ORIGIN || requestHost !== PRODUCTION_APP_HOST) return null;
  return { origins: [PRODUCTION_UTS_ORIGIN] };
}
