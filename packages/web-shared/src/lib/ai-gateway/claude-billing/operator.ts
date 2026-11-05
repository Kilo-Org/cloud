import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { oidcFederationProvider } from '@anthropic-ai/sdk/lib/credentials/oidc-federation';
import { TokenCache } from '@anthropic-ai/sdk/lib/credentials/token-cache';
import type { AccessTokenProvider } from '@anthropic-ai/sdk/lib/credentials/types';
import {
  CLAUDE_API_BASE_URL,
  CLAUDE_OPERATOR_FEDERATION_RULE_ID,
  CLAUDE_OPERATOR_ORGANIZATION_ID,
  CLAUDE_OPERATOR_SERVICE_ACCOUNT_ID,
  CLAUDE_OPERATOR_TOKEN_AUDIENCE,
  CLAUDE_OPERATOR_WORKSPACE_ID,
} from '@kilocode/web-shared/lib/auth/claude/config';
import { signClaudeFederationJwt } from '@kilocode/web-shared/lib/auth/claude/federation-jwt';
import { createCachedFetch } from '@kilocode/web-shared/lib/cached-fetch';

/**
 * Kilo's operator service account on the Claude API.
 *
 * It authenticates with Workload Identity Federation: each exchange presents a
 * fresh Kilo-signed JWT, and the SDK trades it for a short-lived access token.
 * Only this service account may send requests that bill a connected customer,
 * and it also creates the customer profiles.
 */

/**
 * Anthropic mints a token that lives at most twice the identity JWT's remaining
 * lifetime, so 30 minutes allows up to an hour of reuse per exchange.
 */
const IDENTITY_TOKEN_LIFETIME_SECONDS = 30 * 60;

export function isClaudeOperatorConfigured(): boolean {
  return Boolean(
    CLAUDE_OPERATOR_FEDERATION_RULE_ID &&
    CLAUDE_OPERATOR_ORGANIZATION_ID &&
    CLAUDE_OPERATOR_SERVICE_ACCOUNT_ID &&
    CLAUDE_OPERATOR_TOKEN_AUDIENCE
  );
}

function operatorTokenProvider(): AccessTokenProvider {
  return oidcFederationProvider({
    identityTokenProvider: () =>
      signClaudeFederationJwt({
        audience: CLAUDE_OPERATOR_TOKEN_AUDIENCE,
        lifetimeSeconds: IDENTITY_TOKEN_LIFETIME_SECONDS,
      }),
    federationRuleId: CLAUDE_OPERATOR_FEDERATION_RULE_ID,
    organizationId: CLAUDE_OPERATOR_ORGANIZATION_ID,
    serviceAccountId: CLAUDE_OPERATOR_SERVICE_ACCOUNT_ID,
    ...(CLAUDE_OPERATOR_WORKSPACE_ID ? { workspaceId: CLAUDE_OPERATOR_WORKSPACE_ID } : {}),
    baseURL: CLAUDE_API_BASE_URL,
    fetch: globalThis.fetch,
  });
}

let tokenCache: TokenCache | null = null;

/** The operator's current access token, refreshed before it expires. */
export async function getClaudeOperatorToken(): Promise<string> {
  tokenCache ??= new TokenCache(operatorTokenProvider());
  return await tokenCache.getToken();
}

/** Drops the cached token after the Claude API rejected it as unauthenticated. */
export function invalidateClaudeOperatorToken(): void {
  tokenCache?.invalidate();
}

let client: Anthropic | null = null;

/** An SDK client that authenticates as the operator service account. */
export function getClaudeOperatorClient(): Anthropic {
  client ??= new Anthropic({ baseURL: CLAUDE_API_BASE_URL, credentials: operatorTokenProvider() });
  return client;
}

/** Creates one customer profile. Anthropic creates a new profile on every call. */
export async function createClaudeUserProfile(): Promise<string> {
  const profile = await getClaudeOperatorClient().beta.userProfiles.create({});
  return profile.id;
}

const SERVED_MODELS_TTL_MS = 10 * 60 * 1000;

/**
 * The model IDs the operator's organization can serve. An empty set means no
 * successful fetch yet, which callers treat as "do not filter".
 */
export const getClaudeServedModelIds = createCachedFetch<ReadonlySet<string>>(
  async () => {
    const ids = new Set<string>();
    for await (const model of getClaudeOperatorClient().models.list({ limit: 1000 })) {
      ids.add(model.id);
    }
    return ids;
  },
  SERVED_MODELS_TTL_MS,
  new Set(),
  { name: 'claudeServedModels' }
);
