import { getEnvVariable } from '@/lib/dotenvx';
import { findKiloExclusiveModel } from '@/lib/ai-gateway/models';
import { isGptOssModel } from '@/lib/ai-gateway/providers/openai';
import type {
  GatewayRequest,
  GatewayResponsesRequest,
} from '@/lib/ai-gateway/providers/openrouter/types';
import type { Provider } from '@/lib/ai-gateway/providers/types';
import { OPENAI_CHATGPT_RECONNECT_MESSAGE, resolveOpenAiChatGptAccessToken } from './refresh';
import { getOpenAiChatGptStoredConnection } from './store';

/**
 * Routing for the delegated "Sign in with ChatGPT" connection. When a person
 * has an enabled connection, an eligible OpenAI model is served by api.openai.com
 * on the delegated token instead of a managed gateway.
 */

/** The partner project key, already a managed BYOK credential (`ENVIRONMENT.md`). */
export const OPENAI_CHATGPT_API_KEY_ENV = 'OPENAI_API_KEY';

/** The production upstream; the same discovery-driven environment overrides as
 *  the OIDC endpoints (`OPENAI_DISCOVERY_URL`, `OPENAI_TOKEN_ENDPOINT`) apply. */
export const OPENAI_CHATGPT_API_URL =
  getEnvVariable('OPENAI_CHATGPT_API_URL').trim().replace(/\/+$/, '') ||
  'https://api.openai.com/v1';

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

export type OpenAiChatGptRoutingResult =
  | {
      kind: 'provider';
      provider: Provider;
      userByok: null;
      bypassAccessCheck: false;
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
  const model = requestedModel.trim();
  return OPENAI_MODEL_PREFIX.test(model) && !isGptOssModel(model) && !findKiloExclusiveModel(model);
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
  const { request, requestedModel, userId } = input;

  if (request.kind !== 'responses') return false;
  if (!userId) return false;
  if (!isOpenAiChatGptModel(requestedModel)) return false;

  const stored = await getOpenAiChatGptStoredConnection(userId);
  // The payload's `status` mirrors a save or a terminal failure, but a person
  // can also disable the row through the ordinary BYOK toggle, which leaves the
  // payload saying `connected`. Both must hold for the route to be eligible.
  return stored?.isEnabled === true && stored.connection.status === 'connected';
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
    },
  };
}

/**
 * Resolves the ChatGPT connection as a provider, a reconnect requirement, or
 * null when the request is not eligible or cannot be served. A `reconnect`
 * result is returned when the person's enabled credential is terminally dead:
 * the request must fail readably instead of silently running on another billing
 * path. Callers keep the standard balance and abuse checks
 * (`bypassAccessCheck: false`), exactly like the Vercel BYOK path.
 */
export async function checkOpenAiChatGptByok(
  input: OpenAiChatGptRoutingInput
): Promise<OpenAiChatGptRoutingResult | null> {
  if (input.userId === null) return null;
  if (!(await isOpenAiChatGptEligible(input))) return null;

  const outcome = await resolveOpenAiChatGptAccessToken(input.userId);

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
  };
}
