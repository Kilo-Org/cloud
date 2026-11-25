/** Vercel delivers a project's OIDC token in this header on every Function invocation. */
export const VERCEL_OIDC_TOKEN_HEADER = 'x-vercel-oidc-token';

/**
 * Reads the caller identity for `POST /v1/bundle` on Vercel. Functions receive the token in the
 * `x-vercel-oidc-token` request header (two-hour lifetime, rotated inside the function's
 * execution window); local development falls back to the `VERCEL_OIDC_TOKEN` value that
 * `vercel env pull` writes to `.env.local`.
 * https://vercel.com/docs/oidc/reference
 */
export function vercelIdentityToken(request: Request): string | undefined {
  const fromHeader = request.headers.get(VERCEL_OIDC_TOKEN_HEADER)?.trim();
  if (fromHeader) return fromHeader;
  const fromEnv =
    typeof process === 'undefined' ? undefined : process.env.VERCEL_OIDC_TOKEN?.trim();
  return fromEnv || undefined;
}
