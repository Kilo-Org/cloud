import { getEnvVariable } from '@/lib/dotenvx';
import { findKiloExclusiveModel } from '@/lib/ai-gateway/models';
import { isGptOssModel } from '@/lib/ai-gateway/providers/openai';
import type {
  GatewayRequest,
  GatewayResponsesRequest,
} from '@/lib/ai-gateway/providers/openrouter/types';
import type { Provider } from '@/lib/ai-gateway/providers/types';
import { ensureFreshOpenAiChatGptAccessToken } from './refresh';
import { getOpenAiChatGptConnection } from './store';

/**
 * Routing for the delegated "Sign in with ChatGPT" connection. When a person
 * has an enabled connection, an eligible OpenAI model is served by api.openai.com
 * on the delegated token instead of a managed gateway.
 */

/** The partner project key, already a managed BYOK credential (`ENVIRONMENT.md`). */
export const OPENAI_CHATGPT_API_KEY_ENV = 'OPENAI_API_KEY';

export const OPENAI_CHATGPT_API_URL = 'https://api.openai.com/v1';

/**
 * The delegated access token travels in its own upstream header. `extraHeaders`
 * is merged into the upstream request by `upstream-request.ts`; the partner key
 * stays the bearer credential on `Authorization`.
 */
export const OPENAI_ON_BEHALF_OF_TOKEN_HEADER = 'OpenAI-On-Behalf-Of-Token';

/** The gateway addresses this model as `openai/...`; api.openai.com does not. */
const OPENAI_MODEL_PREFIX = /^openai\//i;

export type OpenAiChatGptRoutingInput = {
  request: GatewayRequest;
  requestedModel: string;
  /** Null for anonymous callers, who can never own a connection. */
  userId: string | null;
};

export type OpenAiChatGptRoutingResult = {
  kind: 'provider';
  provider: Provider;
  userByok: null;
  bypassAccessCheck: false;
};

function isOpenAiChatGptModel(requestedModel: string): boolean {
  const model = requestedModel.trim();
  return OPENAI_MODEL_PREFIX.test(model) && !isGptOssModel(model) && !findKiloExclusiveModel(model);
}

/**
 * An enabled, readable ChatGPT connection wins for a delegated OpenAI model.
 * The delegated-token flow is accepted only by `POST /v1/responses`: a
 * `chat/completions` request for the same model keeps its current route, and
 * declaring `chat_completions` support here would make the gateway answer the
 * person with an api-kind error instead of their existing provider.
 */
export async function isOpenAiChatGptEligible(input: OpenAiChatGptRoutingInput): Promise<boolean> {
  const { request, requestedModel, userId } = input;

  if (request.kind !== 'responses') return false;
  if (!userId) return false;
  if (getEnvVariable(OPENAI_CHATGPT_API_KEY_ENV).trim().length === 0) return false;
  if (!isOpenAiChatGptModel(requestedModel)) return false;

  const connection = await getOpenAiChatGptConnection(userId);
  // `status` mirrors the row's `is_enabled`: saving sets connected/enabled and a
  // terminal failure sets error/disabled. An absent or unreadable row returns
  // null, so neither can be routed.
  return connection?.status === 'connected';
}

/**
 * Builds the provider that serves the delegated request. Returns null when the
 * partner key is missing or no access token can be obtained: a terminally
 * expired connection is already disabled with a readable reason by the store,
 * so the request falls back to the existing route and the person's session
 * never breaks. An upstream failure *after* a token was obtained is returned to
 * the client as-is by the gateway and is never silently replayed through
 * another billing path.
 */
export async function buildOpenAiChatGptProvider(userId: string): Promise<Provider | null> {
  const apiKey = getEnvVariable(OPENAI_CHATGPT_API_KEY_ENV);
  if (apiKey.trim().length === 0) return null;

  const accessToken = await ensureFreshOpenAiChatGptAccessToken(userId);
  if (!accessToken) return null;

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

      // The token is fetched once while the provider is resolved, so a
      // terminal refresh failure can fall back to the existing route instead
      // of failing after the request was already committed to this provider.
      // Resolution and the upstream send happen back-to-back in the same
      // gateway request, so the captured token is still the fresh one.
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
    },
  };
}

/**
 * Resolves the ChatGPT connection as a provider, or null when the request is
 * not eligible or the connection cannot produce a token. Callers keep the
 * standard balance and abuse checks (`bypassAccessCheck: false`), exactly like
 * the Vercel BYOK path.
 */
export async function checkOpenAiChatGptByok(
  input: OpenAiChatGptRoutingInput
): Promise<OpenAiChatGptRoutingResult | null> {
  if (input.userId === null) return null;
  if (!(await isOpenAiChatGptEligible(input))) return null;

  const provider = await buildOpenAiChatGptProvider(input.userId);
  if (!provider) return null;

  return {
    kind: 'provider',
    provider,
    userByok: null,
    bypassAccessCheck: false,
  };
}
