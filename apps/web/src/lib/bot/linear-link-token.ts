import 'server-only';
import { createSignedToken, verifySignedToken } from '@/lib/signed-token';

// Linear link tokens are embedded in public Linear issue comments, so anyone
// in the workspace can see the URL. We sign a short-lived payload that binds
// the link to a specific platform integration; the payload deliberately does
// NOT carry any Linear user id. The clicker proves which Linear identity to
// link by completing a fresh Linear OAuth round-trip from `/linear/link`.

const TOKEN_TTL_SECONDS = 30 * 60;

export type VerifiedLinearLinkToken = {
  platformIntegrationId: string;
  organizationId: string;
};

function parseLinearLinkToken(payload: Record<string, unknown>): VerifiedLinearLinkToken | null {
  if (
    typeof payload.platformIntegrationId !== 'string' ||
    payload.platformIntegrationId.length === 0
  ) {
    return null;
  }
  if (typeof payload.organizationId !== 'string' || payload.organizationId.length === 0) {
    return null;
  }
  return {
    platformIntegrationId: payload.platformIntegrationId,
    organizationId: payload.organizationId,
  };
}

export function createLinearLinkToken(params: {
  platformIntegrationId: string;
  organizationId: string;
}): string {
  return createSignedToken({
    platformIntegrationId: params.platformIntegrationId,
    organizationId: params.organizationId,
  });
}

export function verifyLinearLinkToken(token: string | null): VerifiedLinearLinkToken | null {
  return verifySignedToken(token, { ttlSeconds: TOKEN_TTL_SECONDS, parse: parseLinearLinkToken });
}
