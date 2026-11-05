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
    fetch: (input, init) =>
      globalThis.fetch(input, { ...init, signal: AbortSignal.timeout(15_000) }),
  });
}

let tokenCache: TokenCache | null = null;

export async function getClaudeOperatorToken(): Promise<string> {
  tokenCache ??= new TokenCache(operatorTokenProvider());
  return await tokenCache.getToken();
}

export function invalidateClaudeOperatorToken(): void {
  tokenCache?.invalidate();
}

let client: Anthropic | null = null;

export function getClaudeOperatorClient(): Anthropic {
  client ??= new Anthropic({
    baseURL: CLAUDE_API_BASE_URL,
    apiKey: null,
    authToken: null,
    credentials: operatorTokenProvider(),
    timeout: 15_000,
    // Profile creation is not idempotent: a lost reply must not create a second profile automatically.
    maxRetries: 0,
  });
  return client;
}

// Each create call makes a new profile; callers must serialize first-time creation.
export async function createClaudeUserProfile(): Promise<string> {
  const profile = await getClaudeOperatorClient().beta.userProfiles.create({});
  return profile.id;
}
