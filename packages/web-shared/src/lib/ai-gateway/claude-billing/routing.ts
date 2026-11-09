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
import { findUserById } from '@kilocode/web-shared/lib/user/find-user-by-id';
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
  /**
   * The platform caller for a service run, such as code review or the Discord
   * bot; see `OpenAiChatGptRoutingInput`. Set with an organization, it makes the
   * organization's shared-services connection the first candidate.
   */
  botId: string | undefined;
};

export type ClaudeBillingRoutingResult =
  | { kind: 'provider'; provider: Provider; userByok: null; skipBalanceCheck: true }
  /** The owner has a connection that cannot bill. Never serve it another way. */
  | { kind: 'unavailable'; message: string; retryable?: boolean };

/**
 * The connections a request may use, in order. A member's own request in an
 * organization uses their connection for that organization, never their
 * personal one, and a personal request uses only the personal connection. A
 * service run carries a bot id: it uses the organization's shared-services
 * connection first, because that connection exists so a service run does not
 * spend a member's own Claude organization, and falls back to the caller's
 * connection, which is what every existing caller has.
 */
function ownerCandidates(input: ClaudeBillingRoutingInput): ClaudeBillingOwner[] {
  if (!input.userId) return [];
  const owners: ClaudeBillingOwner[] = [];
  if (input.botId && input.organizationId) {
    owners.push({ kind: 'shared_services', organizationId: input.organizationId });
  }
  owners.push(
    input.organizationId
      ? { kind: 'member', kiloUserId: input.userId, organizationId: input.organizationId }
      : { kind: 'personal', kiloUserId: input.userId }
  );
  return owners;
}

/**
 * The email the release flag is checked against. A person's own connection is
 * gated on the person making the request. A shared-services connection is
 * gated on the person who connected it, because a service run's caller is
 * often a bot that no release flag covers.
 */
async function gateEmail(
  input: ClaudeBillingRoutingInput,
  owner: ClaudeBillingOwner,
  connection: ClaudeBillingPayerState
): Promise<string | null> {
  if (owner.kind !== 'shared_services') return input.requesterEmail;
  return (await findUserById(connection.created_by))?.google_user_email ?? null;
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
 * Resolves a Claude billing connection as a provider, an unavailable result, or
 * null when the request cannot be served by one. A connection is read before
 * anything about Kilo's configuration: once an owner has a connection, a missing
 * or broken operator credential fails the request instead of quietly serving it
 * on Kilo's credits. A connection that cannot bill fails the request without
 * trying the next one, and a connection that is absent or removed moves on to
 * the next candidate.
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
    } catch {
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
    const email = await gateEmail(input, owner, connection);
    if (!email || !(await isClaudePlatformOAuthEnabled(email))) {
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
