import type { Context, MiddlewareHandler } from 'hono';
import type { MCPGatewayEnv } from '../types';

export const CLIENT_IP_HEADER = 'CF-Connecting-IP';
const UNKNOWN_CLIENT_KEY = 'unknown-client';

const MISSING_BINDING: unique symbol = Symbol('missing');

async function consumeLimit(
  binding: RateLimit | undefined,
  key: string
): Promise<boolean | typeof MISSING_BINDING> {
  if (!binding) return MISSING_BINDING;
  try {
    const outcome = await binding.limit({ key });
    return outcome.success;
  } catch {
    // The edge limiter is a best-effort guard; failing open keeps the gateway
    // available if the binding is temporarily unavailable.
    return true;
  }
}

export function limitedResponse(c: Context<MCPGatewayEnv>) {
  return c.json({ error: 'rate_limited' }, 429);
}

/**
 * One rate-limit window per client IP for the tokenless gateway surface. Uses
 * the edge-provided client IP; client-supplied forwarded headers are ignored.
 * Requests that carry a bearer token are metered by the authenticated runtime
 * windows instead, so this check does not consume their IP budget. No-op when
 * the binding is absent (unit tests, non-prod envs).
 */
export const anonymousClientLimiter: MiddlewareHandler<MCPGatewayEnv> = async (c, next) => {
  const authorization = c.req.header('authorization');
  if (authorization && authorization.trim().length > 0) {
    await next();
    return;
  }
  const ip = c.req.header(CLIENT_IP_HEADER)?.trim() || UNKNOWN_CLIENT_KEY;
  const outcome = await consumeLimit(c.env.MCP_GATEWAY_UNAUTH_LIMITER, `ip:${ip}`);
  if (outcome === MISSING_BINDING || outcome === true) {
    await next();
    return;
  }
  return limitedResponse(c);
};

/**
 * Per-user and per-config windows for the authenticated runtime path, checked
 * after token verification and before any runtime-state loading. No-op when
 * the binding is absent.
 */
export async function enforceRuntimeLimits(params: {
  env: MCPGatewayEnv['Bindings'];
  userId: string;
  configId: string;
}): Promise<boolean> {
  const binding = params.env.MCP_GATEWAY_RUNTIME_LIMITER;
  const userOutcome = await consumeLimit(binding, `user:${params.userId}`);
  if (userOutcome === false) return false;
  const configOutcome = await consumeLimit(binding, `config:${params.configId}`);
  return configOutcome !== false;
}

/**
 * Records one usage data point per proxied request in the bound analytics
 * dataset so runtime volume is metered and attributable. Never throws into
 * the request path; blobs carry only non-secret correlation fields.
 */
export function recordProxyUsage(params: {
  env: MCPGatewayEnv['Bindings'];
  configId: string;
  ownerScope: string;
  method: string;
  outcomeStatus: number;
}): void {
  try {
    params.env.MCP_GATEWAY_ANALYTICS?.writeDataPoint({
      indexes: [params.configId],
      blobs: ['runtime_proxy', params.ownerScope, params.method, String(params.outcomeStatus)],
      doubles: [params.outcomeStatus],
    });
  } catch {
    // Metering must not affect the proxied response.
  }
}
