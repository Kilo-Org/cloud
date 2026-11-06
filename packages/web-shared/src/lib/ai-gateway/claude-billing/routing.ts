import 'server-only';
import { isClaudeModel } from '@kilocode/web-shared/lib/ai-gateway/providers/anthropic/claude-model';
import { appendAnthropicBetaHeader } from '@kilocode/web-shared/lib/ai-gateway/providers/anthropic/beta-header';
import { resolveOpenRouterModelAlias } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import type {
  GatewayChatApiKind,
  Provider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import {
  CLAUDE_API_BASE_URL,
  CLAUDE_BILLING_BETA,
} from '@kilocode/web-shared/lib/auth/claude/config';
import { isClaudePlatformOAuthEnabled } from '@kilocode/web-shared/lib/auth/claude/feature-flag.server';
import { ClaudeBillingConnectionStatus } from '@kilocode/db/schema-types';
import type { ClaudeBillingOwner } from './store';
import { getAuthoritativeClaudeBillingState, type ClaudeBillingPayerState } from './payer-state';
import { getClaudeOperatorToken, isClaudeOperatorConfigured } from './operator';

/** The provider type of a request served on a customer's Claude organization. */
export { CLAUDE_BILLING_PROVIDER_ID } from './provider-id';

export const CLAUDE_BILLING_REQUIRED_MESSAGE =
  'Your Claude organization link cannot bill right now. An owner or admin can link it again, or check it at https://platform.claude.com/connected-platforms.';

const ANTHROPIC_VERSION = '2023-06-01';
/** Marks a request as authenticated by an OAuth token rather than an API key. */
const OAUTH_API_BETA = 'oauth-2025-04-20';
const ANTHROPIC_MODEL_PREFIX = /^anthropic\//i;

export type ClaudeBillingRoutingInput = {
  request: GatewayRequest;
  requestedModel: string;
  userId: string | null;
  requesterEmail: string | null;
  organizationId: string | undefined;
};

export type ClaudeBillingRoutingResult =
  | { kind: 'provider'; provider: Provider; userByok: null; skipBalanceCheck: true }
  /** The owner has a connection that cannot bill. Never serve it another way. */
  | { kind: 'unavailable'; message: string; retryable?: boolean };

/**
 * The owner whose connection serves the request. An organization request uses
 * only the organization's connection, and a personal request only the person's.
 */
function ownerOf(input: ClaudeBillingRoutingInput): ClaudeBillingOwner | null {
  if (input.organizationId) {
    return { kind: 'organization', organizationId: input.organizationId };
  }
  return input.userId ? { kind: 'personal', kiloUserId: input.userId } : null;
}

/** Billing connections serve the Messages API and Anthropic's OpenAI-compatible endpoint. */
function servesApiKind(kind: GatewayChatApiKind): boolean {
  return kind === 'messages' || kind === 'chat_completions';
}

/**
 * The upstream model ID for a gateway model ID, or null when the model cannot
 * take this route. The gateway addresses Anthropic models as
 * `anthropic/claude-sonnet-4.6`; Anthropic uses `claude-sonnet-4-6`.
 */
export async function resolveClaudeBillingModel(requestedModel: string): Promise<string | null> {
  const model = (await resolveOpenRouterModelAlias(requestedModel.trim())).trim();
  if (!ANTHROPIC_MODEL_PREFIX.test(model) || !isClaudeModel(model)) return null;
  return model.replace(ANTHROPIC_MODEL_PREFIX, '').replace(/(\d)\.(\d)/g, '$1-$2');
}

/**
 * Adds the fields this route sends. The gateway body type does not declare
 * `billing_policy`, so it is assigned rather than spread into the literal.
 */
function markBilled(body: { model: string }, upstreamModel: string): void {
  body.model = upstreamModel;
  // The customer pays because they directed this request: Kilo never bills a
  // customer for its own work.
  Object.assign(body, { billing_policy: { type: 'billing_policy', bill_to: 'user_profile' } });
  // A gateway-only routing object is not part of the Anthropic API.
  Reflect.deleteProperty(body, 'provider');
}

export function buildClaudeBillingProvider(
  accessToken: string,
  upstreamModel: string,
  owner: ClaudeBillingOwner,
  userProfileId: string
): Provider {
  return {
    type: 'claude-billing',
    claudeBillingOwner: owner,
    claudeBillingUserProfileId: userProfileId,
    apiUrl: `${CLAUDE_API_BASE_URL}/v1`,
    apiUrlOverrides: {},
    disableUrlSuffix: false,
    apiKey: accessToken,
    apiKeyHeader: null,
    supportedChatApis: ['messages', 'chat_completions'],
    responseTransforms: null,
    async transformRequest(context) {
      // Only the billed API kinds reach this provider; `responses` never does.
      if (context.request.kind === 'responses') return;
      context.extraHeaders['anthropic-version'] ??= ANTHROPIC_VERSION;
      appendAnthropicBetaHeader(context.extraHeaders, OAUTH_API_BETA);
      appendAnthropicBetaHeader(context.extraHeaders, CLAUDE_BILLING_BETA);
      context.extraHeaders['anthropic-user-profile-id'] = userProfileId;
      markBilled(context.request.body, upstreamModel);
    },
  };
}

/**
 * Resolves the owner's Claude billing connection as a provider, an unavailable
 * result, or null when the request is not this owner's to bill. The connection
 * is read before anything about Kilo's configuration: once an owner has a
 * connection, a missing or broken operator credential fails the request instead
 * of quietly serving it on Kilo's credits.
 */
export async function checkClaudeBilling(
  input: ClaudeBillingRoutingInput
): Promise<ClaudeBillingRoutingResult | null> {
  const owner = ownerOf(input);
  if (!owner) return null;

  const upstreamModel = await resolveClaudeBillingModel(input.requestedModel);
  if (!upstreamModel) return null;

  let connection: ClaudeBillingPayerState | null;
  try {
    connection = await getAuthoritativeClaudeBillingState(owner);
  } catch {
    return {
      kind: 'unavailable',
      message: 'We could not check your Claude link. Try again.',
      retryable: true,
    };
  }
  if (!connection || connection.status === ClaudeBillingConnectionStatus.Removed) return null;
  if (connection.status === ClaudeBillingConnectionStatus.BillingUnavailable) {
    return { kind: 'unavailable', message: CLAUDE_BILLING_REQUIRED_MESSAGE };
  }
  if (connection.status !== ClaudeBillingConnectionStatus.Connected) return null;
  if (
    !input.userId ||
    !input.requesterEmail ||
    !(await isClaudePlatformOAuthEnabled(input.requesterEmail))
  ) {
    return {
      kind: 'unavailable',
      message:
        'Linked billing with Claude Platform is not enabled. Remove the link to use another payment method.',
    };
  }
  if (!servesApiKind(input.request.kind)) {
    return {
      kind: 'unavailable',
      message: 'Use the Messages or Chat Completions API with your Claude link.',
    };
  }
  if (!isClaudeOperatorConfigured()) {
    return { kind: 'unavailable', message: CLAUDE_BILLING_REQUIRED_MESSAGE };
  }

  const accessToken = await getClaudeOperatorToken();
  return {
    kind: 'provider',
    provider: {
      ...buildClaudeBillingProvider(accessToken, upstreamModel, owner, connection.user_profile_id),
      claudeBillingConnectedAt: connection.connected_at ?? undefined,
    },
    userByok: null,
    skipBalanceCheck: true,
  };
}
