import 'server-only';
import { isClaudeModel } from '@kilocode/web-shared/lib/ai-gateway/providers/anthropic/claude-model';
import { appendAnthropicBetaHeader } from '@kilocode/web-shared/lib/ai-gateway/providers/anthropic/beta-header';
import { dropThinkingBlocksOnPrefixMismatch } from '@kilocode/web-shared/lib/ai-gateway/providers/anthropic/thinking-block-binding';
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
import { ClaudeBillingConnectionStatus } from '@kilocode/db/schema-types';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import type { ClaudeBillingOwner } from './store';
import { resolveConnectionConnector } from '../connector';
import {
  getAuthoritativeClaudeBillingState,
  ClaudeBillingPayerStateParseError,
  type ClaudeBillingPayerState,
} from './payer-state';
import { getClaudeOperatorToken, isClaudeOperatorConfigured } from './operator';

export { CLAUDE_BILLING_PROVIDER_ID } from './provider-id';

export const CLAUDE_BILLING_REQUIRED_MESSAGE =
  'Your Claude organization link cannot bill right now. An owner or admin can link it again, or check it at https://platform.claude.com/linked-platforms.';

/**
 * Shown when the account that linked an organization's connection is gone: the
 * account row is missing, the account is soft-deleted or being deleted, or it
 * holds no usable email. The copy names that condition instead of an
 * organization membership, which routing never checks. The connection belongs
 * to the organization, so an owner reconnects it instead of losing it.
 */
export const CLAUDE_BILLING_RECONNECT_MESSAGE =
  'The account that linked Claude billing for this organization is no longer available, so requests in this organization cannot bill through it.';

const ANTHROPIC_VERSION = '2023-06-01';
/** Marks a request as authenticated by an OAuth token rather than an API key. */
const OAUTH_API_BETA = 'oauth-2025-04-20';
const ANTHROPIC_MODEL_PREFIX = /^anthropic\//i;

export type ClaudeBillingRoutingInput = {
  request: GatewayRequest;
  requestedModel: string;
  userId: string | null;
  organizationId: string | undefined;
};

export type ClaudeBillingRoutingResult =
  | { kind: 'provider'; provider: Provider; userByok: null; skipBalanceCheck: true }
  /** The owner has a connection that cannot bill. Never serve it another way. */
  | { kind: 'unavailable'; message: string; retryable?: boolean }
  /**
   * The organization's connection was linked by a person who is gone, so it
   * cannot bill. Never serve it another way, and never retry: only an
   * organization owner reconnecting it changes the outcome.
   */
  | { kind: 'reconnect'; message: string };

/**
 * The connection a request may use. A request in an organization, whether a
 * member's own request or a bot's service run, uses that organization's
 * connection and never the requester's personal one. A personal request uses
 * only the personal connection.
 */
function ownerCandidates(input: ClaudeBillingRoutingInput): ClaudeBillingOwner[] {
  if (!input.userId) return [];
  return input.organizationId
    ? [{ kind: 'organization', organizationId: input.organizationId }]
    : [{ kind: 'personal', kiloUserId: input.userId }];
}

/**
 * True when an organization connection's connector is gone: the account that
 * linked it is missing, soft-deleted, being deleted, or has no usable email.
 * A personal connection has no connector to lose, and an organization
 * connection with no recorded connector keeps serving.
 */
async function connectorGone(
  owner: ClaudeBillingOwner,
  connection: ClaudeBillingPayerState
): Promise<boolean> {
  if (owner.kind !== 'organization' || !connection.created_by) return false;
  const connector = await resolveConnectionConnector(connection.created_by, readDb);
  return connector.kind === 'gone';
}

/**
 * Billing connections serve only the Messages API. Anthropic's OpenAI-compatible
 * endpoint ignores prompt caching and drops reasoning output.
 */
function servesApiKind(kind: GatewayChatApiKind): boolean {
  return kind === 'messages';
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
    inferenceProviderId: 'anthropic',
    claudeBillingOwner: owner,
    claudeBillingUserProfileId: userProfileId,
    apiUrl: `${CLAUDE_API_BASE_URL}/v1`,
    apiUrlOverrides: {},
    disableUrlSuffix: false,
    apiKey: accessToken,
    apiKeyHeader: null,
    supportedChatApis: ['messages'],
    responseTransforms: null,
    async transformRequest(context) {
      // Only the Messages API reaches this provider.
      if (context.request.kind !== 'messages') return;
      context.extraHeaders['anthropic-version'] ??= ANTHROPIC_VERSION;
      appendAnthropicBetaHeader(context.extraHeaders, OAUTH_API_BETA);
      appendAnthropicBetaHeader(context.extraHeaders, CLAUDE_BILLING_BETA);
      dropThinkingBlocksOnPrefixMismatch(context);
      context.extraHeaders['anthropic-user-profile-id'] = userProfileId;
      markBilled(context.request.body, upstreamModel);
    },
  };
}

/**
 * Resolves a Claude billing connection as a provider, an unavailable result, or
 * null when the request cannot be served by one. A connection is read before
 * anything about Kilo's configuration: once an owner has a connection, a missing
 * or broken operator credential fails the request instead of quietly serving it
 * on Kilo's credits. A connection that cannot bill fails the request instead of
 * trying another payer.
 */
export async function checkClaudeBilling(
  input: ClaudeBillingRoutingInput
): Promise<ClaudeBillingRoutingResult | null> {
  const owners = ownerCandidates(input);
  // An organization request is always scoped by its signed-in person.
  if (owners.length === 0) {
    return input.organizationId
      ? {
          kind: 'unavailable',
          message:
            'Linked billing with Claude Platform is not enabled. Remove the link to use another payment method.',
        }
      : null;
  }

  const upstreamModel = await resolveClaudeBillingModel(input.requestedModel);
  if (!upstreamModel) return null;

  for (const owner of owners) {
    let connection: ClaudeBillingPayerState | null;
    try {
      connection = await getAuthoritativeClaudeBillingState(owner);
    } catch (error) {
      // A reply outside the wire contract names a release mismatch, so the
      // refusal stays without a retry hint; other failures stay retryable.
      if (error instanceof ClaudeBillingPayerStateParseError) {
        return {
          kind: 'unavailable',
          message:
            'Your Claude link cannot be checked right now. This usually clears after a short wait, and an owner or admin can check the link at any time.',
        };
      }
      return {
        kind: 'unavailable',
        message: 'We could not check your Claude link. Try again.',
        retryable: true,
      };
    }
    if (!connection || connection.status === ClaudeBillingConnectionStatus.Removed) continue;
    if (connection.status === ClaudeBillingConnectionStatus.BillingUnavailable) {
      return { kind: 'unavailable', message: CLAUDE_BILLING_REQUIRED_MESSAGE };
    }
    if (connection.status !== ClaudeBillingConnectionStatus.Connected) continue;
    if (await connectorGone(owner, connection)) {
      return { kind: 'reconnect', message: CLAUDE_BILLING_RECONNECT_MESSAGE };
    }
    if (!servesApiKind(input.request.kind)) {
      return {
        kind: 'unavailable',
        message: 'Use the Messages API with your Claude link.',
      };
    }
    if (!isClaudeOperatorConfigured()) {
      return { kind: 'unavailable', message: CLAUDE_BILLING_REQUIRED_MESSAGE };
    }

    const accessToken = await getClaudeOperatorToken();
    return {
      kind: 'provider',
      provider: {
        ...buildClaudeBillingProvider(
          accessToken,
          upstreamModel,
          owner,
          connection.user_profile_id
        ),
        claudeBillingConnectedAt: connection.connected_at ?? undefined,
      },
      userByok: null,
      skipBalanceCheck: true,
    };
  }

  return null;
}
