import { getEnvVariable } from '@/lib/dotenvx';
import { findKiloExclusiveModel, isDisabledKiloExclusiveModel } from '@/lib/ai-gateway/models';
import { isGptOssModel } from '@/lib/ai-gateway/providers/openai';
import type {
  GatewayRequest,
  GatewayResponsesRequest,
} from '@/lib/ai-gateway/providers/openrouter/types';
import type { Provider } from '@/lib/ai-gateway/providers/types';
import { OPENAI_CHATGPT_RECONNECT_MESSAGE, resolveOpenAiChatGptAccessToken } from './refresh';
import { getOpenAiChatGptStoredConnection, type OpenAiChatGptOwner } from './store';
import { isOpenAiModelServed } from './served-models';
import { OPENAI_CHATGPT_API_URL } from './upstream';

/**
 * Routing for the delegated "Sign in with ChatGPT" connection. When a person
 * has an enabled connection, an eligible OpenAI model is served by api.openai.com
 * on the delegated token instead of a managed gateway.
 */

/** The delegated upstream URL, shared with the served-model lookup. */
export { OPENAI_CHATGPT_API_URL };

/**
 * The delegated route must carry a key from the project that owns the OAuth
 * client. `OPENAI_API_KEY` is a different project's key: it is handed to the
 * Vercel AI Gateway as an OpenAI BYOK credential. Keep the two apart so neither
 * path inherits the other's project, quota, or billing.
 */
export const OPENAI_CHATGPT_API_KEY_ENV = 'OPENAI_CHATGPT_API_KEY';

/**
 * The delegated access token travels in its own upstream header. `extraHeaders`
 * is merged into the upstream request by `upstream-request.ts`; the partner key
 * stays the bearer credential on `Authorization`.
 */
export const OPENAI_ON_BEHALF_OF_TOKEN_HEADER = 'OpenAI-On-Behalf-Of-Token';

/** The gateway addresses this model as `openai/...`; api.openai.com does not. */
const OPENAI_MODEL_PREFIX = /^openai\//i;

/**
 * OpenAI's traceability metadata for subscription sharing. The activity type is
 * stable for the integration; the purpose is a short, human-readable reason and
 * must never contain prompt, document, or credential content.
 */
const OPENAI_CHATGPT_ACTIVITY = 'coding_agent';
const OPENAI_CHATGPT_PURPOSE = "Run the user's coding task in Kilo Code.";

/** OpenAI's metadata limits: 16 entries and 512 characters per value. */
const METADATA_ENTRY_LIMIT = 16;
const METADATA_VALUE_LIMIT = 512;

/**
 * Adds the required traceability keys to the request metadata, keeping any
 * caller-supplied entries. `session_id` is the gateway's identifier for one
 * run, which is what `subscription_sharing_activity_id` expects; it is optional
 * and is omitted when absent. When the merge would exceed the entry limit the
 * caller's oldest entries are dropped before the required ones.
 */
function withTraceabilityMetadata(
  metadata: Record<string, string> | null | undefined,
  sessionId: string | null
): Record<string, string> {
  const traceability: Record<string, string> = {
    subscription_sharing_activity: OPENAI_CHATGPT_ACTIVITY,
    subscription_sharing_purpose: OPENAI_CHATGPT_PURPOSE,
  };
  const activityId = sessionId?.trim() ?? '';
  if (activityId !== '' && activityId.length <= METADATA_VALUE_LIMIT) {
    traceability.subscription_sharing_activity_id = activityId;
  }

  const merged: Record<string, string> = { ...(metadata ?? {}), ...traceability };
  const removable = Object.keys(merged).filter(key => !(key in traceability));
  while (Object.keys(merged).length > METADATA_ENTRY_LIMIT && removable.length > 0) {
    delete merged[removable.shift() as string];
  }
  return merged;
}

export type OpenAiChatGptRoutingInput = {
  request: GatewayRequest;
  requestedModel: string;
  /** Null for anonymous callers, who can never own a connection. */
  userId: string | null;
  /**
   * The organization the request runs for. Set means the request must use that
   * organization's connection and never the caller's personal one.
   */
  organizationId: string | undefined;
};

export type OpenAiChatGptRoutingResult =
  | {
      kind: 'provider';
      provider: Provider;
      userByok: null;
      bypassAccessCheck: false;
      skipBalanceCheck: true;
    }
  | {
      /**
       * The person has an enabled connection for an eligible request, but the
       * stored credential is terminally dead. The request must fail with the
       * reconnect message: serving it through another billing path would spend
       * a different allowance without telling the person.
       */
      kind: 'reconnect';
      message: string;
    };

function isOpenAiChatGptModel(requestedModel: string): boolean {
  const model = requestedModel.trim().toLowerCase();
  // Disabling a Kilo-only alias must not turn it into a delegated OpenAI model;
  // retired Kilo aliases are not upstream model IDs either.
  return (
    OPENAI_MODEL_PREFIX.test(model) &&
    !isGptOssModel(model) &&
    !findKiloExclusiveModel(model) &&
    !isDisabledKiloExclusiveModel(model)
  );
}

/**
 * Resolves the connection owner for a request. The connection is inherently
 * personal, so the owner is always the caller and the organization only scopes
 * which of their connections applies. An organization request uses the
 * caller's connection for that organization and never their personal one, so an
 * organization without the caller's connection falls through to the API path.
 * Anonymous callers have no owner.
 */
function openAiChatGptOwner(input: OpenAiChatGptRoutingInput): OpenAiChatGptOwner | null {
  if (!input.userId) return null;
  return { kiloUserId: input.userId, organizationId: input.organizationId ?? null };
}

/**
 * An enabled, readable ChatGPT connection makes a delegated OpenAI model
 * eligible. The partner project key is deliberately not part of this check: a
 * missing deployment credential must not hide the person's connection state.
 * The delegated-token flow is accepted only by `POST /v1/responses`: a
 * `chat/completions` request for the same model keeps its current route, and
 * declaring `chat_completions` support here would make the gateway answer the
 * person with an api-kind error instead of their existing provider.
 */
export async function isOpenAiChatGptEligible(input: OpenAiChatGptRoutingInput): Promise<boolean> {
  const { request, requestedModel } = input;

  if (request.kind !== 'responses') return false;
  const owner = openAiChatGptOwner(input);
  if (!owner) return false;
  if (!isOpenAiChatGptModel(requestedModel)) return false;

  // The catalog can list an OpenAI model the plain API does not serve. A
  // `-pro` slug such as `openai/gpt-5.6-luna-pro` is a reasoning mode on the
  // base model, not an API model id, so sending it upstream fails the request.
  // Only a model this project actually serves may take the delegated route.
  const upstreamModel = requestedModel.trim().replace(OPENAI_MODEL_PREFIX, '');
  if (!(await isOpenAiModelServed(getEnvVariable(OPENAI_CHATGPT_API_KEY_ENV), upstreamModel))) {
    return false;
  }

  const stored = await getOpenAiChatGptStoredConnection(owner);
  // The payload's `status` mirrors a save or a terminal failure, but a person
  // can also disable the row through the ordinary BYOK toggle, which leaves the
  // payload saying `connected`. Both must hold for the route to be eligible.
  return stored?.isEnabled === true && stored.connection.status === 'connected';
}

/**
 * The catalog model ids an enabled ChatGPT connection can serve, for the models
 * list's BYOK tag. Returns null when the person has no usable connection, so the
 * caller leaves the list untouched. The served-model gate is the same one
 * routing uses, so a model is tagged only when the delegated route can carry it.
 */
export async function getOpenAiChatGptByokModelIds(
  owner: OpenAiChatGptOwner,
  candidateModelIds: readonly string[]
): Promise<Set<string> | null> {
  const stored = await getOpenAiChatGptStoredConnection(owner);
  if (stored?.isEnabled !== true || stored.connection.status !== 'connected') return null;

  const apiKey = getEnvVariable(OPENAI_CHATGPT_API_KEY_ENV);
  if (apiKey.trim().length === 0) return null;

  const tagged = await Promise.all(
    candidateModelIds.filter(isOpenAiChatGptModel).map(async modelId => {
      const upstreamModel = modelId.trim().replace(OPENAI_MODEL_PREFIX, '');
      return (await isOpenAiModelServed(apiKey, upstreamModel)) ? modelId : null;
    })
  );
  return new Set(tagged.filter((id): id is string => id !== null));
}

/**
 * Returns `models` with the ChatGPT-served ones marked BYOK-available, so the
 * model picker and the extension show the BYOK badge like pasted BYOK keys. The
 * list is returned unchanged when the person has no usable connection.
 */
export async function tagOpenAiChatGptByokModels<
  T extends { id: string; hasUserByokAvailable?: boolean },
>(owner: OpenAiChatGptOwner, models: T[]): Promise<T[]> {
  const byokModelIds = await getOpenAiChatGptByokModelIds(
    owner,
    models.map(model => model.id)
  );
  if (!byokModelIds) return models;
  return models.map(model =>
    model.hasUserByokAvailable === true || !byokModelIds.has(model.id)
      ? model
      : { ...model, hasUserByokAvailable: true }
  );
}

/**
 * Builds the provider that serves the delegated request. Returns null when the
 * partner key is missing: the deployment is misconfigured for token sharing, so
 * the request falls back to the existing route and the person's session never
 * breaks. A terminal connection failure is reported by `checkOpenAiChatGptByok`
 * before this point, so it never reaches another billing path. An upstream
 * failure *after* a token was obtained is returned to the client as-is by the
 * gateway and is never silently replayed through another billing path.
 */
export function buildOpenAiChatGptProvider(apiKey: string, accessToken: string): Provider | null {
  if (apiKey.trim().length === 0) return null;

  return {
    id: 'openai-chatgpt',
    apiUrl: OPENAI_CHATGPT_API_URL,
    apiUrlOverrides: {},
    apiKey,
    apiKeyHeader: null,
    supportedChatApis: ['responses'],
    responseTransforms: null,
    async transformRequest(context) {
      if (context.request.kind !== 'responses') return;

      // The delegated token is resolved before the provider is built, so a
      // terminal refresh failure is reported to the person instead of silently
      // running this request on another billing path. Resolution and the
      // upstream send happen back-to-back in the same gateway request, so the
      // captured token is still the fresh one.
      context.extraHeaders[OPENAI_ON_BEHALF_OF_TOKEN_HEADER] = accessToken;

      const body = context.request.body as GatewayResponsesRequest;
      if (typeof body.model === 'string') {
        body.model = body.model.trim().replace(OPENAI_MODEL_PREFIX, '');
      }
      // Stored conversations, background mode and hosted tools are not
      // supported by the delegated flow, so the request is forced stateless.
      body.store = false;
      delete body.conversation;
      delete body.background;
      // The gateway-only routing object is not part of the OpenAI API and
      // api.openai.com rejects unknown request arguments, exactly like the
      // other raw upstream providers strip it.
      delete body.provider;
      // OpenAI requires this traceability metadata on every delegated Responses
      // request, including later turns. Without it the request is rejected once
      // the integration is enabled for it.
      body.metadata = withTraceabilityMetadata(body.metadata, context.session_id);
    },
  };
}

/**
 * Resolves the ChatGPT connection as a provider, a reconnect requirement, or
 * null when the request is not eligible or cannot be served. A `reconnect`
 * result is returned when the person's enabled credential is terminally dead:
 * the request must fail readably instead of silently running on another billing
 * path. Callers keep the standard abuse and organization policy checks
 * (`bypassAccessCheck: false`), but skip the zero-balance paid-model block:
 * the ChatGPT plan pays for the request, not Kilo credits.
 */
export async function checkOpenAiChatGptByok(
  input: OpenAiChatGptRoutingInput
): Promise<OpenAiChatGptRoutingResult | null> {
  const owner = openAiChatGptOwner(input);
  if (!owner) return null;
  if (!(await isOpenAiChatGptEligible(input))) return null;

  const outcome = await resolveOpenAiChatGptAccessToken(owner);

  if (outcome.kind === 'terminal') {
    return { kind: 'reconnect', message: OPENAI_CHATGPT_RECONNECT_MESSAGE };
  }
  // `no_connection` and a transient `failed` refresh keep the existing route.
  if (outcome.kind !== 'access_token') return null;

  const apiKey = getEnvVariable(OPENAI_CHATGPT_API_KEY_ENV);
  const provider = buildOpenAiChatGptProvider(apiKey, outcome.accessToken);
  if (!provider) return null;

  return {
    kind: 'provider',
    provider,
    userByok: null,
    bypassAccessCheck: false,
    skipBalanceCheck: true,
  };
}
