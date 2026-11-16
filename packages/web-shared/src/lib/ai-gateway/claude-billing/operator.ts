import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { oidcFederationProvider } from '@anthropic-ai/sdk/lib/credentials/oidc-federation';
import { TokenCache } from '@anthropic-ai/sdk/lib/credentials/token-cache';
import type { AccessTokenProvider } from '@anthropic-ai/sdk/lib/credentials/types';
import { z } from 'zod';
import {
  CLAUDE_API_BASE_URL,
  CLAUDE_BILLING_CLIENT_ID,
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

/** Anthropic requires this beta to unlink, whatever its name suggests. */
const UNLINK_BETA = 'user-profiles-search-2026-08-30';

const unlinkResponseSchema = z.object({ revoked_connection_ids: z.array(z.string()) });

export type ClaudeUserProfileUnlinkResult =
  | { kind: 'unlinked'; revokedConnectionIds: string[] }
  /** Anthropic did not answer usefully; the same call can succeed later. */
  | { kind: 'retry' }
  /** Anthropic refused the call; Kilo cannot end the link itself, the customer can. */
  | { kind: 'needs_console' };

function unlinkStatusResult(status: number): ClaudeUserProfileUnlinkResult {
  if (status === 401 || status === 408 || status === 425 || status === 429 || status >= 500) {
    return { kind: 'retry' };
  }
  return { kind: 'needs_console' };
}

/**
 * Ends the profile's link to Kilo's app, so the customer's Linked platforms page
 * stops showing Kilo and a later link of the same Claude organization is
 * accepted. The profile itself stays. An empty `revokedConnectionIds` means the
 * profile had no link to end, which is success.
 */
export async function unlinkClaudeUserProfile(
  userProfileId: string,
  timeoutMs = 15_000
): Promise<ClaudeUserProfileUnlinkResult> {
  if (!CLAUDE_BILLING_CLIENT_ID) return { kind: 'needs_console' };
  let response: Response;
  try {
    response = await fetch(
      `${CLAUDE_API_BASE_URL}/v1/user_profiles/${encodeURIComponent(userProfileId)}/unlink`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await getClaudeOperatorToken()}`,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': UNLINK_BETA,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ oauth_app_id: CLAUDE_BILLING_CLIENT_ID }),
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      }
    );
  } catch {
    return { kind: 'retry' };
  }
  if (!response.ok) {
    // A cached operator token can be stale or revoked; a fresh one is minted on
    // the next attempt, so 401 is worth retrying rather than sending the
    // customer to Claude Console.
    if (response.status === 401) invalidateClaudeOperatorToken();
    return unlinkStatusResult(response.status);
  }
  const parsed = unlinkResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return { kind: 'retry' };
  return { kind: 'unlinked', revokedConnectionIds: parsed.data.revoked_connection_ids };
}
