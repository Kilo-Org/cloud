const PRODUCTION_AI_GATEWAY_ORIGIN = 'https://ai-gateway.kilo.ai';
const STAGING_AI_GATEWAY_ORIGIN = 'https://staging-ai-gateway.kilo.ai';
// Matches AI_GATEWAY_BASE_PORT in dev/local/services.ts.
const LOCAL_AI_GATEWAY_BASE_PORT = 3010;

// apps/ai-gateway serves every route under /api/v1 (see apps/ai-gateway/AGENTS.md).
// Each rewrite is one of:
// - Drop-in: `/api/gateway/<path>` here serves what `/api/<path>` serves on the
//   gateway, so ai-gateway.kilo.ai/api replaces api.kilo.ai/api/gateway as a base URL.
// - Legacy: a path apps/web served before the gateway moved out. Its gateway
//   route has a different path, so only this app keeps it working.
// The first matching rewrite wins, so each more specific source must precede
// the catch-all it overlaps.
export const AI_GATEWAY_PATH_REWRITES = [
  // Drop-in for every gateway route, including /v1/fim/completions,
  // /v1/edit/completions, /v1/systemone and /v1/organizations/:id/models.
  { source: '/api/gateway/v1/:path*', destination: '/api/v1/:path*' },
  // Legacy: the typesafe SystemOne path. Must precede /api/gateway/:path*.
  { source: '/api/gateway/typesafe/v1/systemone', destination: '/api/v1/systemone' },
  // Legacy: unversioned gateway paths, such as the `https://api.kilo.ai/api/gateway/`
  // base URL that OpenClaw and the mobile app use.
  { source: '/api/gateway/:path*', destination: '/api/v1/:path*' },
  // Legacy: the OpenRouter-compatible prefix, versioned and unversioned.
  { source: '/api/openrouter/v1/:path*', destination: '/api/v1/:path*' },
  { source: '/api/openrouter/:path*', destination: '/api/v1/:path*' },
  // Legacy: autocomplete.
  { source: '/api/fim/completions', destination: '/api/v1/fim/completions' },
  { source: '/api/edit/completions', destination: '/api/v1/edit/completions' },
  // Legacy: organization models.
  { source: '/api/organizations/:id/models', destination: '/api/v1/organizations/:id/models' },
  {
    source: '/api/organizations/:id/models/validate',
    destination: '/api/v1/organizations/:id/models/validate',
  },
];

/**
 * The web app has no gateway routes of its own, so every build needs an origin.
 * Outside Vercel that is the local ai-gateway app on its dev:start port.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export function resolveAiGatewayOrigin(env) {
  if (env.AI_GATEWAY_URL) return new URL(env.AI_GATEWAY_URL).origin;
  if (env.VERCEL_TARGET_ENV === 'production') return PRODUCTION_AI_GATEWAY_ORIGIN;
  if (env.VERCEL_TARGET_ENV === 'staging') return STAGING_AI_GATEWAY_ORIGIN;
  if (env.VERCEL) {
    throw new Error(
      `No AI gateway for Vercel target "${env.VERCEL_TARGET_ENV}". Set AI_GATEWAY_URL.`
    );
  }
  const portOffset = Number(env.KILO_PORT_OFFSET) || 0;
  return `http://localhost:${LOCAL_AI_GATEWAY_BASE_PORT + portOffset}`;
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{ source: string, destination: string }[]}
 */
export function buildAiGatewayRewrites(env) {
  const origin = resolveAiGatewayOrigin(env);
  return AI_GATEWAY_PATH_REWRITES.map(({ source, destination }) => ({
    source,
    destination: `${origin}${destination}`,
  }));
}
