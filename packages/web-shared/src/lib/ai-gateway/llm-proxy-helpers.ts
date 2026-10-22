import { after, NextResponse, type NextRequest } from 'next/server';
import * as z from 'zod';
import { FEATURE_HEADER, type FeatureValue } from '@kilocode/web-shared/lib/feature-detection';
import {
  countAndStoreUsage,
  logMicrodollarUsageAndReportToBouncer,
  processTokenData,
} from '@kilocode/web-shared/lib/ai-gateway/processUsage';
import { startInactiveSpan, captureException, captureMessage } from '@sentry/nextjs';
import { APP_URL, FIRST_TOPUP_BONUS_AMOUNT } from '@kilocode/web-shared/lib/constants';
import { summarizeUserPayments } from '@kilocode/web-shared/lib/creditTransactions';
import { isAutoTopUpInFlight } from '@kilocode/web-shared/lib/autoTopUpInFlight';
import { type User } from '@kilocode/db/schema';
import { errorExceptInTest, warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';

import type { Span } from '@sentry/nextjs';
import { debugSaveProxyResponseStream } from '@kilocode/web-shared/lib/debugUtils';
import type { OrganizationSettings } from '@kilocode/web-shared/lib/organizations/organization-types';
import type {
  OpenRouterChatCompletionRequest,
  OpenRouterProviderConfig,
  GatewayRequest,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import { getFraudDetectionHeaders } from '@kilocode/web-shared/lib/fraud-detection-headers';
import { toMicrodollars } from '@kilocode/web-shared/lib/microdollars';
import { normalizeProjectId } from '@kilocode/web-shared/lib/normalizeProjectId';
import { getXKiloCodeVersionNumber } from '@kilocode/web-shared/lib/userAgent';
import { getEffectiveProviderPrivacy } from '@kilocode/web-shared/lib/ai-gateway/provider-privacy';
import { createParser, type EventSourceMessage } from 'eventsource-parser';
import { sentryRootSpan } from '../getRootSpan';
import {
  findKiloExclusiveModel,
  shouldRedactErrorResponse,
} from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';
import type {
  MicrodollarUsageContext,
  MicrodollarUsageStats,
  PromptInfo,
} from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
import { detectContextOverflow } from '@kilocode/web-shared/lib/ai-gateway/context-overflow';
import {
  KILO_AUTO_BALANCED_MODEL,
  KILO_AUTO_FREE_MODEL,
} from '@kilocode/web-shared/lib/ai-gateway/auto-model';
import type {
  GatewayChatApiKind,
  ProviderId,
} from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { computeOpenRouterCostFields } from '@kilocode/web-shared/lib/ai-gateway/processUsage.shared';
import { ProxyErrorType } from '@kilocode/web-shared/lib/proxy-error-types';
import type { UserByokProviderId } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import {
  AUTO_DECISION_HEADER,
  CUSTOM_ROUTER_ERROR_HTTP_STATUS,
  type CustomRouterErrorCode,
} from '@kilocode/auto-routing-contracts';
import type { AutoDecisionRejection } from '@kilocode/web-shared/lib/ai-gateway/auto-model/auto-decision';

// FIM suffix markers for tracking purposes - used to wrap suffix in a fake system prompt format
// This allows FIM requests to be tracked consistently with chat requests
const fimSuffixFakeSysPrompMarkers = { begin: '[FIM_SUFFIX:', end: ']' } as const;

const PAID_MODEL_AUTH_REQUIRED = 'PAID_MODEL_AUTH_REQUIRED';
// Kilo clients show a sign-up prompt for this code and do not retry the request.
const PROMOTION_MODEL_LIMIT_REACHED = 'PROMOTION_MODEL_LIMIT_REACHED';

export function invalidPathResponse() {
  return NextResponse.json(
    {
      error: 'Invalid path',
      error_type: ProxyErrorType.invalid_path,
      message: 'This endpoint only accepts the path `/chat/completions`.',
    },
    { status: 400 }
  );
}

export function invalidRequestResponse() {
  return NextResponse.json(
    {
      error: 'Invalid request',
      error_type: ProxyErrorType.invalid_request,
      message: 'Could not parse request body. Please ensure it is valid JSON.',
    },
    { status: 400 }
  );
}

export function malformedJsonResponse(parseError: unknown) {
  const detail = parseError instanceof Error ? parseError.message : String(parseError);
  return NextResponse.json(
    {
      error: 'Malformed JSON',
      error_type: ProxyErrorType.invalid_request,
      message: `Request body is not valid JSON: ${detail}`,
    },
    { status: 400 }
  );
}

/**
 * Error code a client matches on to detect a credential it has to replace.
 *
 * It is carried in `error.code` rather than inferred from the status, because
 * the same status also carries the sign-in prompts served to anonymous callers.
 */
export const INVALID_TOKEN_CODE = 'INVALID_TOKEN';

/**
 * Response for a request that presented a credential which failed verification.
 *
 * Such a request must not be answered as an anonymous caller. The caller
 * believes it is authenticated, so downgrading it silently drops the account,
 * its organization, its BYOK keys and its credits, and hides the broken
 * credential from the client that sent it. Fail loudly so the client can
 * re-authenticate.
 */
export function invalidTokenResponse() {
  return NextResponse.json(
    {
      error: {
        code: INVALID_TOKEN_CODE,
        message: 'Your authentication token is invalid. Please sign in again.',
      },
      error_type: ProxyErrorType.authentication_required,
    },
    {
      status: 401,
      headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' },
    }
  );
}

export function temporarilyUnavailableResponse() {
  return NextResponse.json(
    {
      error: 'Service Unavailable',
      error_type: ProxyErrorType.temporarily_unavailable,
      message: 'The service is temporarily unavailable. Please try again later.',
    },
    { status: 503 }
  );
}

export async function usageLimitExceededResponse(user: User, balance?: number) {
  const payments = await summarizeUserPayments(user.id);

  const title = !payments.payments_count ? 'Paid Model - Credits Required' : 'Low Credit Warning!';

  const message =
    !payments.payments_count && FIRST_TOPUP_BONUS_AMOUNT > 0
      ? `This is a paid model. To use paid models, you need to add credits. Get $${FIRST_TOPUP_BONUS_AMOUNT} free on your first topup!`
      : 'Add credits to continue, or switch to a free model';

  return NextResponse.json(
    {
      error: {
        // https://github.com/Kilo-Org/kilocode/blob/d34b562041b5ef823d9f6b4bd96448750576b340/src/core/task/Task.ts#L2868
        title,
        message,
        balance,
        buyCreditsUrl: APP_URL + '/profile',
      },
      error_type: ProxyErrorType.usage_limit_exceeded,
    },
    { status: 402 }
  );
}

/**
 * Returned when a paid request is blocked at a non-positive balance while an
 * auto-top-up is in flight. The balance is expected to recover when the
 * `invoice.paid` webhook posts credits, so this is a transient, retryable
 * condition rather than a terminal no-credits state.
 *
 * The message must not contain "credit", "payment", "balance", or "quota":
 * agent runtimes classify those words as a terminal insufficient-credits error.
 */
export function topUpInProgressResponse() {
  const message = 'Your top-up is processing. Please retry in a few seconds.';
  return NextResponse.json(
    {
      error: message,
      error_type: ProxyErrorType.top_up_in_progress,
      message,
    },
    { status: 503, headers: { 'Retry-After': '5' } }
  );
}

/**
 * Builds the response for a request that is blocked because the billing
 * entity has no available balance. If an auto-top-up is in flight, the block is
 * transient and reported as retryable; otherwise it is the terminal
 * low-credits response.
 *
 * A block caused by an exhausted per-user allowance is never retryable: an
 * organization top-up restores the organization balance, not the member's
 * allowance, so the retry would not resolve.
 */
export async function creditsBlockedResponse(params: {
  user: User;
  balance?: number;
  organizationId?: string;
  balanceLimitedByUserAllowance?: boolean;
}) {
  if (
    !params.balanceLimitedByUserAllowance &&
    (await isAutoTopUpInFlight({ userId: params.user.id, organizationId: params.organizationId }))
  ) {
    return topUpInProgressResponse();
  }
  return await usageLimitExceededResponse(params.user, params.balance);
}

export function dataCollectionRequiredResponse() {
  const error =
    'Data collection is required for this model. Please enable data collection to use this model or choose another model.';
  return NextResponse.json(
    {
      error: error, // this field is shown in the extension
      error_type: ProxyErrorType.data_collection_required,
      message: error,
    },
    { status: 400 }
  );
}

function isProviderSlugList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(slug => typeof slug === 'string');
}

function invalidProviderOnlyResponse() {
  const error = 'provider.only must be a list of provider slugs.';
  return NextResponse.json(
    { error, error_type: ProxyErrorType.invalid_request, message: error },
    { status: 400 }
  );
}

export function checkExclusiveModelProviderAllowed(
  model: string,
  provider: OpenRouterProviderConfig | undefined
) {
  if (!provider) return null;
  const exclusiveModel = findKiloExclusiveModel(model);
  if (!exclusiveModel) return null;
  const requestedOnly: unknown = provider.only;
  if (requestedOnly !== undefined && requestedOnly !== null && !isProviderSlugList(requestedOnly)) {
    return invalidProviderOnlyResponse();
  }
  const inferenceProviders = exclusiveModel.inference_providers;
  if (inferenceProviders.length === 0) return null;
  if (
    inferenceProviders.some(
      inferenceProvider =>
        (!provider.only || provider.only.includes(inferenceProvider)) &&
        (!provider.ignore || !provider.ignore.includes(inferenceProvider))
    )
  )
    return null;
  const error = `No eligible provider can serve the selected model. Please enable provider: ${inferenceProviders.join(', ')}`;
  return NextResponse.json(
    {
      error: error,
      error_type: ProxyErrorType.provider_not_allowed,
      message: error,
    },
    { status: 403 }
  );
}

export function apiKindNotSupportedResponse(
  apiKind: GatewayChatApiKind,
  supportedApiKinds: ReadonlyArray<GatewayChatApiKind>
) {
  const error = `This model does not support the ${apiKind} API, please use any of: ${supportedApiKinds.join()}`;
  warnExceptInTest(`[apiKindNotSupportedResponse] ${error}`);
  return NextResponse.json(
    { error, error_type: ProxyErrorType.api_kind_not_supported, message: error },
    { status: 400 }
  );
}

async function redactedErrorResponse(response: Response) {
  const error = 'The upstream provider was unable to process the request';
  warnExceptInTest(`Responding with ${response.status} ${error}`);
  return NextResponse.json(
    { error, error_type: ProxyErrorType.upstream_error, message: error },
    { status: response.status }
  );
}

const BYOK_MODEL_PERMISSION_DENIED_MESSAGE =
  '[BYOK] Your API key does not have permission to access this model. Please check your API key permissions.';

const OPENCODE_GO_BYOK_MODEL_PERMISSION_DENIED_MESSAGE =
  '[BYOK] Your API key does not have permission to access this model. Some OpenCode Go models require opting in to data collection or region-specific inference in OpenCode Go.';

const byokErrorMessages: Record<number, string> = {
  401: '[BYOK] Your API key is invalid or has been revoked. Please check your API key configuration.',
  402: '[BYOK] Your API account has insufficient funds. Please check your billing details with your API provider.',
  403: BYOK_MODEL_PERMISSION_DENIED_MESSAGE,
  429: '[BYOK] Your API key has hit its rate limit. Please try again later or check your rate limit settings with your API provider.',
};

const byokUpstreamErrorSchema = z.object({
  error: z.object({ message: z.string() }).optional().catch(undefined),
  message: z.string().optional().catch(undefined),
});

async function readByokProviderMessage(response: Response): Promise<string | undefined> {
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  const parsed = byokUpstreamErrorSchema.safeParse(body);
  if (!parsed.success) return undefined;
  const providerMessage = parsed.data.error?.message ?? parsed.data.message;
  return (
    providerMessage
      ?.replace(/\p{Cc}/gu, ' ')
      .trim()
      .slice(0, 300) || undefined
  );
}

function specificByokErrorMessage(
  status: number,
  userByokProviderIds: UserByokProviderId[]
): string | undefined {
  if (status === 403 && userByokProviderIds.includes('opencode-go')) {
    return OPENCODE_GO_BYOK_MODEL_PERMISSION_DENIED_MESSAGE;
  }
  return byokErrorMessages[status];
}

async function byokErrorMessage(
  response: Response,
  userByokProviderIds: UserByokProviderId[]
): Promise<string | undefined> {
  const specificMessage = specificByokErrorMessage(response.status, userByokProviderIds);
  if (!specificMessage && (response.status < 400 || response.status >= 500)) return undefined;

  // The provider's own explanation (for example an expired rather than revoked
  // key) is often more actionable than our status-based summary.
  const providerMessage = await readByokProviderMessage(response);
  if (specificMessage) {
    return providerMessage
      ? `${specificMessage} Provider message: ${providerMessage}`
      : specificMessage;
  }
  return providerMessage
    ? `[BYOK] ${providerMessage}`
    : '[BYOK] Your provider rejected the request. Check your provider account and settings.';
}

function vertexByokModelNotFoundResponse(
  response: Response,
  userByokProviderIds: UserByokProviderId[] | null
) {
  if (
    userByokProviderIds === null ||
    !userByokProviderIds.includes('vertex') ||
    response.status !== 404
  ) {
    return undefined;
  }

  const error =
    '[BYOK] Google Vertex AI could not find the requested model. The model might not be enabled for your Google Cloud project or selected Vertex location.';
  warnExceptInTest(`Responding with ${response.status} ${error}`);
  return NextResponse.json(
    { error, error_type: ProxyErrorType.byok_error, message: error },
    { status: response.status }
  );
}

const noAllowedProvidersErrorSchema = z.object({
  message: z.literal('No allowed providers are available for the selected model.'),
  code: z.literal(404),
  metadata: z.object({
    available_providers: z.array(z.string()),
    requested_providers: z.array(z.string()),
  }),
});

const openRouterErrorResponseSchema = z.object({
  error: noAllowedProvidersErrorSchema.optional(),
  message: z.string().optional(),
  code: z.number().optional(),
  metadata: z.unknown().optional(),
});

async function providerNotAllowedResponse(providerId: ProviderId, response: Response) {
  if (providerId !== 'openrouter' || response.status !== 404) return undefined;

  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return undefined;
  }

  const parsedBody = openRouterErrorResponseSchema.safeParse(body);
  if (!parsedBody.success) return undefined;

  const upstreamError = parsedBody.data.error ?? parsedBody.data;
  if (!noAllowedProvidersErrorSchema.safeParse(upstreamError).success) return undefined;

  const error = 'No eligible provider can serve the selected model.';
  return NextResponse.json(
    {
      error,
      error_type: ProxyErrorType.provider_not_allowed,
      message: `${error} Select another model or update the provider routing settings.`,
    },
    { status: response.status }
  );
}

export async function makeErrorReadable({
  providerId,
  requestedModel,
  request,
  response,
  userByokProviderIds,
}: {
  providerId: ProviderId;
  requestedModel: string;
  request: GatewayRequest;
  response: Response;
  userByokProviderIds: UserByokProviderId[] | null;
}) {
  if (response.status < 400) {
    return undefined;
  }

  const vertexByokResponse = vertexByokModelNotFoundResponse(response, userByokProviderIds);
  if (vertexByokResponse) return vertexByokResponse;

  const specificByokMessage =
    userByokProviderIds === null
      ? undefined
      : specificByokErrorMessage(response.status, userByokProviderIds);
  if (specificByokMessage === undefined) {
    const providerErrorResponse = await providerNotAllowedResponse(providerId, response);
    if (providerErrorResponse) return providerErrorResponse;

    const overflowResponse = await detectContextOverflow({ requestedModel, request, response });
    if (overflowResponse) return overflowResponse;
  }

  if (userByokProviderIds !== null) {
    const byokMessage = await byokErrorMessage(response, userByokProviderIds);
    if (byokMessage) {
      if (specificByokMessage !== undefined) {
        // Log only the fixed text so this line stays stable to search on;
        // captureProxyError already logs the upstream body.
        warnExceptInTest(`Responding with ${response.status} ${specificByokMessage}`);
      }
      return NextResponse.json(
        {
          error: byokMessage,
          error_type: ProxyErrorType.byok_error,
          message: byokMessage,
        },
        { status: response.status }
      );
    }
  }

  if (shouldRedactErrorResponse(providerId, requestedModel)) {
    return await redactedErrorResponse(response);
  }

  return undefined;
}

export function modelNotAllowedResponse() {
  return NextResponse.json(
    {
      error: 'Model not allowed for your team.',
      error_type: ProxyErrorType.model_not_allowed,
      message: 'The requested model is not allowed for your team.',
    },
    { status: 404 }
  );
}

export function efficientPoolBlockedResponse() {
  const error = 'Auto-routing could not select an eligible model for this request.';
  const message = `${error} Please try again or contact support if the problem persists.`;
  const logMessage = `[efficientPoolBlockedResponse] ${message}`;
  warnExceptInTest(logMessage);
  return NextResponse.json(
    {
      error,
      error_type: ProxyErrorType.model_not_allowed,
      message,
    },
    { status: 503 }
  );
}

export function unavailableModelResponse() {
  const error = 'The requested model is currently unavailable. Please choose a different model.';
  return NextResponse.json(
    { error, error_type: ProxyErrorType.unavailable_model, message: error },
    { status: 404 }
  );
}

export function modelDoesNotExistResponse() {
  return NextResponse.json(
    {
      error: 'Model not found',
      error_type: ProxyErrorType.model_not_found,
      message: 'The requested model could not be found.',
    },
    { status: 404 }
  );
}

/**
 * Returned when an enabled "Sign in with ChatGPT" connection can no longer be
 * refreshed. The stored credential is terminal: the connection has been cleared
 * and disabled, so this is never a retryable condition and must not be served
 * by another billing path. The person is told what happened and what to do.
 */
export function chatGptReconnectResponse(message: string) {
  const error = `${message} Reconnect your ChatGPT connection at ${APP_URL}/byok, or choose a different model.`;
  return NextResponse.json(
    { error, error_type: ProxyErrorType.byok_error, message: error },
    { status: 400 }
  );
}

export function modelDoesNotExistOnOpenRouterResponse(model: string) {
  const error =
    `The requested model '${model}' does not exist. ` +
    `Please use an exact model id as listed on /api/gateway/models. ` +
    `If this is a newly released model, please try again in a few minutes.`;
  errorExceptInTest(`[modelDoesNotExistOnOpenRouterResponse] ${error}`);
  return NextResponse.json(
    {
      error,
      error_type: ProxyErrorType.model_not_found,
      message: error,
    },
    { status: 404 }
  );
}

export function noFreeModelsAvailableResponse() {
  const error = `No free models are currently available for ${KILO_AUTO_FREE_MODEL.id}. Please try again later, or switch to ${KILO_AUTO_BALANCED_MODEL.id} for affordable paid inference.`;
  return NextResponse.json(
    { error, error_type: ProxyErrorType.no_free_models_available, message: error },
    { status: 503 }
  );
}

export function organizationAutoConfigurationResponse(message: string) {
  return NextResponse.json(
    {
      error: 'Organization Auto configuration error',
      error_type: ProxyErrorType.organization_auto_configuration,
      message,
    },
    { status: 400 }
  );
}

export function paidModelAuthRequiredResponse() {
  return NextResponse.json(
    {
      error: {
        code: PAID_MODEL_AUTH_REQUIRED,
        message: 'You need to sign in to use this model.',
      },
      error_type: ProxyErrorType.paid_model_auth_required,
    },
    { status: 401 }
  );
}

// The free-model limits use hour-long windows, so an immediate client retry
// only spends more of the caller's allowance. Kilo CLI v2 and the OpenAI SDKs
// honor this header.
const DO_NOT_RETRY_HEADERS = { 'x-should-retry': 'false' };

export function anonymousFreeModelLimitResponse() {
  const message =
    'Sign up for free to continue and explore 500 other models. ' +
    'Takes 2 minutes, no credit card required. Or come back later.';
  return NextResponse.json(
    {
      error: { code: PROMOTION_MODEL_LIMIT_REACHED, message },
      error_type: ProxyErrorType.rate_limit_exceeded,
      message,
    },
    { status: 429, headers: DO_NOT_RETRY_HEADERS }
  );
}

export function accountFreeModelLimitResponse() {
  const message =
    'Free model usage limit reached. Please try again later, or switch to a paid model or your own API key.';
  return NextResponse.json(
    { error: 'Rate limit exceeded', error_type: ProxyErrorType.rate_limit_exceeded, message },
    { status: 429, headers: DO_NOT_RETRY_HEADERS }
  );
}

export function customRouterErrorResponse(code: CustomRouterErrorCode, message: string) {
  return NextResponse.json(
    { error: { code, message }, error_type: ProxyErrorType.custom_router, message },
    { status: CUSTOM_ROUTER_ERROR_HTTP_STATUS[code] }
  );
}

// A custom router never falls back outside its pool, so a worker that cannot decide fails the
// request with a retryable status instead of serving another model.
export function autoRoutingUnavailableResponse(model: string) {
  const error = `Auto-routing for ${model} is temporarily unavailable. Please retry.`;
  return NextResponse.json(
    { error, error_type: ProxyErrorType.auto_routing_unavailable, message: error },
    { status: 503, headers: { 'Retry-After': '1' } }
  );
}

export function invalidAutoDecisionResponse(reason: AutoDecisionRejection) {
  const message = `The ${AUTO_DECISION_HEADER} header is not valid for this request (${reason}). Request a new routing decision.`;
  return NextResponse.json(
    {
      error: { code: ProxyErrorType.invalid_auto_decision, reason, message },
      error_type: ProxyErrorType.invalid_auto_decision,
      message,
    },
    { status: reason === 'malformed' ? 400 : 403 }
  );
}

export function storeAndPreviousResponseIdIsNotSupported() {
  const error = 'The store and previous_response_id fields are not supported.';
  return NextResponse.json(
    { error, error_type: ProxyErrorType.unsupported_field, message: error },
    { status: 400 }
  );
}

export function getOutputHeaders(response: Response) {
  const outputHeaders = new Headers();

  for (const headerKey of ['date', 'content-type', 'request-id']) {
    const value = response.headers.get(headerKey);
    if (value) outputHeaders.set(headerKey, value);
  }
  outputHeaders.set('Content-Encoding', 'identity');
  // Content-Encoding: identity is here because Vercel modifies encoding/compression and causes issues
  // no-transform keeps a proxy in front of the gateway, such as the web app's rewrite to the
  // ai-gateway app in local dev, from compressing a stream and holding it until the end.
  outputHeaders.set('Cache-Control', 'no-cache, no-transform');

  return outputHeaders;
}

export function wrapInSafeNextResponse(response: Response) {
  return new NextResponse(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: getOutputHeaders(response),
  });
}

export function accountForMicrodollarUsage(
  clonedReponse: Response,
  usageContext: MicrodollarUsageContext,
  openrouterRequestSpan: Span | undefined
) {
  const logFileExtension = usageContext.isStreaming ? '.log.resp.sse' : '.log.resp.json';
  debugSaveProxyResponseStream(clonedReponse, logFileExtension);
  after(countAndStoreUsage(clonedReponse, usageContext, openrouterRequestSpan));
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Field names, never values, of the request as sent upstream, so rejections
 * such as "unknown field" can be attributed from logs alone.
 */
function describeRequestFields(request: unknown): Record<string, string> {
  if (!isObjectRecord(request)) {
    return {};
  }
  const fields: Record<string, string> = {
    requestFields: Object.keys(request).sort().join(','),
  };
  if (Array.isArray(request.messages)) {
    const messageFields = new Set(
      request.messages.filter(isObjectRecord).flatMap(message => Object.keys(message))
    );
    fields.messageFields = [...messageFields].sort().join(',');
  }
  return fields;
}

export async function captureProxyError(params: {
  errorMessage: string;
  user: { id: string };
  request: unknown;
  response: Response;
  organizationId: string | undefined;
  model: string;
  gatewayModel?: string;
  byokProviderIds?: ReadonlyArray<string> | null;
  trackInSentry: boolean;
}) {
  const {
    errorMessage,
    user,
    request,
    response,
    organizationId,
    model,
    gatewayModel,
    byokProviderIds,
    trackInSentry,
  } = params;
  after(
    (async () => {
      const extraErrorData: Record<string, string | number> = {
        kiloUserId: user.id,
        model,
        ...(gatewayModel && gatewayModel !== model ? { gatewayModel } : {}),
        ...(byokProviderIds && byokProviderIds.length > 0
          ? { byokProviderIds: byokProviderIds.join(',') }
          : {}),
        status: response.status,
        statusText: response.statusText,
        responseContentType: response.headers.get('content-type') || '',
        ...(organizationId && { organizationId }),
        ...describeRequestFields(request),
      };

      const clonedReponse = response.clone();
      try {
        extraErrorData.first4kOfResponse = (await clonedReponse.text()).slice(0, 4096);
      } catch {
        // ignore errors when already handling errors...
      }

      errorExceptInTest(errorMessage, extraErrorData);
      if (trackInSentry) {
        captureMessage(errorMessage, {
          level: 'error',
          extra: extraErrorData,
          tags: { source: 'openrouter-proxy' },
          user: { id: user.id },
        });
      }
    })()
  );
}

// ============================================================================
// Shared Helper Functions
// ============================================================================

/**
 * The organization's data collection setting as an upstream provider config.
 * Enterprise model and provider restrictions are not applied here: the member
 * model-access decision enforces them, including group grants that extend the
 * organization baseline.
 */
export function getOrganizationProviderPrivacy(
  settings: OrganizationSettings | undefined
): OpenRouterProviderConfig | undefined {
  if (!settings) return undefined;
  const providerConfig = getEffectiveProviderPrivacy(undefined, settings.data_collection);
  return Object.keys(providerConfig).length > 0 ? providerConfig : undefined;
}

export function extractHeaderAndLimitLength(request: NextRequest, name: string) {
  return request.headers.get(name)?.slice(0, 500)?.trim() || null;
}

export function extractFraudAndProjectHeaders(request: NextRequest) {
  return {
    fraudHeaders: getFraudDetectionHeaders(request.headers),
    xKiloCodeVersion: request.headers.get('X-KiloCode-Version'),
    projectId: normalizeProjectId(request.headers.get('X-KiloCode-ProjectId')),
    numericKiloCodeVersion:
      getXKiloCodeVersionNumber(request.headers.get('X-KiloCode-Version')) || 0,
  };
}

const wrapFimSuffixIntoSystemPrompt = (() => {
  const { begin, end } = fimSuffixFakeSysPrompMarkers;
  const wrapperLen = begin.length + end.length;
  return (suffix: string) => begin + suffix.slice(0, 100 - wrapperLen) + end;
})();

export function extractFimPromptInfo(body: { prompt: string; suffix?: string | null }): PromptInfo {
  return {
    system_prompt_prefix: wrapFimSuffixIntoSystemPrompt(body.suffix || ''), // suffix = context
    system_prompt_length: (body.suffix || '').length + body.prompt.length,
    user_prompt_prefix: body.prompt.slice(0, 100), // prompt = user input
  };
}

/** An input item with a role, as both the chat and the responses APIs use. */
function isRoleMessage(value: unknown): value is { role?: unknown; content?: unknown } {
  return typeof value === 'object' && value !== null && 'role' in value;
}

/** Joins the text of a message content, which is a string or a list of content parts. */
function textFromPromptContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: unknown[] = content;
  const texts: string[] = [];
  for (const part of parts) {
    // The text payload field is always `text`; its part type differs per API
    // (`text` for chat and messages, `input_text` for responses). Non-text
    // parts (images, tool output) carry no `text` field.
    if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
      texts.push(part.text);
    }
  }
  return texts.join('\n');
}

/** The text of the last `user` turn, scanning from the end of the input list. */
function lastUserTurnText(input: unknown): string | null {
  if (typeof input === 'string') return input; // responses accepts a plain prompt string
  if (!Array.isArray(input)) return null;
  const messages: unknown[] = input;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (isRoleMessage(message) && message.role === 'user') {
      return textFromPromptContent(message.content);
    }
  }
  return null;
}

/**
 * The request shapes that carry a user prompt. The body is typed structurally
 * because only the three gateway kinds pass through here, and FIM's `prompt`
 * body is not part of `GatewayRequest`.
 */
type PromptBearingRequest = {
  kind: GatewayChatApiKind | 'fim_completions';
  body: { messages?: unknown; input?: unknown; prompt?: unknown };
};

/**
 * The last user turn's text, which bouncer hashes into a prompt SimHash.
 * Chat Completions and Messages carry it in `messages`, Responses in `input`
 * (a prompt string or an input-item list), FIM in `prompt`. Null when the
 * request carries no user text.
 */
export function lastUserPromptText(request: PromptBearingRequest): string | null {
  if (request.kind === 'responses') return lastUserTurnText(request.body.input);
  if (request.kind === 'fim_completions') {
    return typeof request.body.prompt === 'string' ? request.body.prompt : null;
  }
  return lastUserTurnText(request.body.messages);
}

/**
 * True when the request asked for token-level probabilities, which bouncer
 * reads as a distillation signal. No gateway request type declares all three
 * fields (Messages declares none), so read them structurally.
 */
export function requestedLogprobs(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const logitBias = 'logit_bias' in body ? body.logit_bias : undefined;
  return (
    ('logprobs' in body && Boolean(body.logprobs)) ||
    ('top_logprobs' in body && Boolean(body.top_logprobs)) ||
    (typeof logitBias === 'object' && logitBias !== null && Object.keys(logitBias).length > 0)
  );
}

/** The `n` sampling parameter, or null when the request did not set one. */
export function requestedSamples(body: unknown): number | null {
  if (typeof body !== 'object' || body === null || !('n' in body)) return null;
  return typeof body.n === 'number' ? body.n : null;
}

function reasoningBudgetBucket(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value <= 1_000) return 'le1k';
  if (value <= 4_000) return 'le4k';
  if (value <= 16_000) return 'le16k';
  if (value <= 64_000) return 'le64k';
  return 'gt64k';
}

function isReasoningObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Bounded labels for requested thinking, effort, and reasoning (in that order).
 * Never persist client-provided strings. When effort aliases coexist, prefer
 * Anthropic output_config, then Chat Completions, then the reasoning object.
 */
export function extractReasoningSetting(body: unknown): string | null {
  if (!isReasoningObject(body)) return null;
  const labels: string[] = [];
  const thinking = isReasoningObject(body.thinking) ? body.thinking : undefined;
  if (
    thinking?.type === 'enabled' ||
    thinking?.type === 'adaptive' ||
    thinking?.type === 'disabled'
  ) {
    const bucket = reasoningBudgetBucket(thinking.budget_tokens);
    labels.push(`thinking:${thinking.type}${bucket ? `:${bucket}` : ''}`);
  }

  const outputConfig = isReasoningObject(body.output_config) ? body.output_config : undefined;
  const reasoning = isReasoningObject(body.reasoning) ? body.reasoning : undefined;
  const effort = outputConfig?.effort ?? body.reasoning_effort ?? reasoning?.effort;
  if (typeof effort === 'string') {
    switch (effort) {
      case 'none':
      case 'minimal':
      case 'low':
      case 'medium':
      case 'high':
      case 'xhigh':
      case 'max':
        labels.push(`effort:${effort}`);
        break;
      default:
        labels.push('effort:other');
    }
  }

  if (reasoning?.enabled === false) labels.push('reasoning:disabled');
  const bucket = reasoningBudgetBucket(reasoning?.max_tokens);
  if (bucket) labels.push(`reasoning:budget:${bucket}`);
  return labels.length > 0 ? labels.join('+') : null;
}

// ============================================================================
// FIM-Specific Code
// ============================================================================

export type FimUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export type MistralFimCompletion = {
  id: string;
  object: 'fim.completion';
  model: string;
  usage: FimUsage;
  created: number;
  choices: Array<{
    index: number;
    text: string;
    finish_reason: string;
  }>;
};

export type MistralFimStreamChunk = {
  id: string;
  object: 'fim.completion.chunk';
  model: string;
  created: number;
  choices: Array<{
    index: number;
    delta: {
      content?: string;
    };
    finish_reason: string | null;
  }>;
  usage?: FimUsage; // Only present in final chunk
};

function computeInceptionFimMicrodollarCost(usage: FimUsage): number {
  return Math.round(usage.prompt_tokens * 0.25 + usage.completion_tokens * 0.75);
}

function computeFimMicrodollarCost(usage: FimUsage, provider: ProviderId): number {
  switch (provider) {
    case 'mistral':
      return Math.round(usage.prompt_tokens * 0.3 + usage.completion_tokens * 0.9);
    case 'inception':
      return computeInceptionFimMicrodollarCost(usage);
    default:
      console.error('Unknown provider for FIM cost calculation', provider);
      return 0;
  }
}

function parseMistralFimUsageFromString(
  response: string,
  provider: ProviderId,
  statusCode: number
): MicrodollarUsageStats {
  const json = JSON.parse(response) as MistralFimCompletion;
  const cost_mUsd = computeFimMicrodollarCost(json.usage, provider);

  return {
    messageId: json.id,
    model: json.model,
    responseContent: json.choices[0]?.text || '',
    hasError: !json.model || statusCode >= 400,
    inference_provider: provider,
    inputTokens: json.usage.prompt_tokens,
    outputTokens: json.usage.completion_tokens,
    cacheHitTokens: 0,
    cacheWriteTokens: 0,
    cost_mUsd,
    is_byok: null,
    upstream_id: null,
    finish_reason: null,
    latency: null,
    moderation_latency: null,
    generation_time: null,
    streamed: null,
    cancelled: null,
    status_code: statusCode,
  };
}

async function parseMistralFimUsageFromStream(
  stream: ReadableStream<Uint8Array>,
  requestSpan: Span | undefined,
  provider: ProviderId,
  statusCode: number
): Promise<MicrodollarUsageStats> {
  requestSpan?.end();
  const streamProcessingSpan = startInactiveSpan({
    name: 'fim-stream-processing',
    op: 'performance',
  });
  const timeToFirstTokenSpan = startInactiveSpan({
    name: 'time-to-first-token',
    op: 'performance',
  });

  let messageId: string | null = null;
  let model: string | null = null;
  let responseContent = '';
  let reportedError = statusCode >= 400;
  const startedAt = performance.now();
  let firstTokenReceived = false;
  let usage: FimUsage | undefined;

  const reader = stream.getReader();
  const decoder = new TextDecoder();

  const sseStreamParser = createParser({
    onEvent(event: EventSourceMessage) {
      if (!firstTokenReceived) {
        sentryRootSpan()?.setAttribute('fim.time_to_first_token_ms', performance.now() - startedAt);
        firstTokenReceived = true;
        timeToFirstTokenSpan.end();
      }

      if (event.data === '[DONE]') return;

      try {
        const json = JSON.parse(event.data) as MistralFimStreamChunk;

        model = json.model ?? model;
        messageId = json.id ?? messageId;
        usage = json.usage ?? usage; // Usage comes in final chunk

        const contentDelta = json.choices?.[0]?.delta?.content;
        if (contentDelta) {
          responseContent += contentDelta;
        }
      } catch (e) {
        reportedError = true;
        captureException(e, {
          tags: { source: 'fim_sse_parsing' },
          extra: { eventData: event.data },
        });
      }
    },
  });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sseStreamParser.feed(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
    streamProcessingSpan.end();
  }

  if (!usage) {
    captureMessage('SUSPICIOUS: No usage info in FIM stream', {
      level: 'error',
      tags: { source: 'fim_usage_processing' },
      extra: { messageId, model },
    });
  }

  return {
    messageId,
    model,
    responseContent,
    hasError: reportedError,
    inference_provider: provider,
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    cacheHitTokens: 0,
    cacheWriteTokens: 0,
    cost_mUsd: usage ? computeFimMicrodollarCost(usage, provider) : 0,
    is_byok: null,
    upstream_id: null,
    finish_reason: null,
    latency: null,
    moderation_latency: null,
    generation_time: null,
    streamed: null,
    cancelled: null,
    status_code: statusCode,
  };
}

export function countAndStoreFimUsage(
  clonedResponse: Response,
  usageContext: MicrodollarUsageContext,
  requestSpan: Span | undefined
) {
  const logFileExtension = usageContext.isStreaming ? '.log.resp.sse' : '.log.resp.json';
  debugSaveProxyResponseStream(clonedResponse, logFileExtension);

  const statusCode = usageContext.status_code ?? 0;
  const usageStatsPromise = !clonedResponse.body
    ? Promise.resolve(null)
    : usageContext.isStreaming
      ? parseMistralFimUsageFromStream(
          clonedResponse.body,
          requestSpan,
          usageContext.provider,
          statusCode
        )
      : clonedResponse
          .text()
          .then(content =>
            parseMistralFimUsageFromString(content, usageContext.provider, statusCode)
          );

  after(
    usageStatsPromise.then(usageStats => {
      if (!usageStats) {
        captureMessage('SUSPICIOUS: No FIM usage information', {
          level: 'error',
          tags: { source: 'fim_usage_processing' },
          extra: { usageContext },
        });
        return;
      }

      usageStats.market_cost = usageStats.cost_mUsd;

      if (usageContext.is_free || usageContext.user_byok) {
        usageStats.cost_mUsd = 0;
        usageStats.cacheDiscount_mUsd = 0;
      }

      // Persist billing, then report the same request to bouncer's usage ledger.
      return logMicrodollarUsageAndReportToBouncer(usageStats, usageContext);
    })
  );
}

// ============================================================================
// Edit-Specific Code
// ============================================================================

type EditMessage = { role: string; content: string };

export function extractEditPromptInfo(body: { messages: EditMessage[] }): PromptInfo {
  const lastUser = [...body.messages].reverse().find(m => m.role === 'user');
  const content = lastUser?.content ?? '';
  return {
    system_prompt_prefix: '', // /v1/edit/completions bakes its system prompt in server-side
    system_prompt_length: 0,
    user_prompt_prefix: content.slice(0, 100),
  };
}

type EditUsage = FimUsage & {
  cached_input_tokens?: number;
};

type MercuryEditCompletionResponse = {
  id?: string;
  model?: string;
  usage?: EditUsage;
  choices?: Array<{
    index?: number;
    message?: { role?: string; content?: string };
    finish_reason?: string | null;
  }>;
};

function getEditCacheHitTokens(usage: EditUsage): number {
  return Math.min(usage.prompt_tokens, Math.max(usage.cached_input_tokens ?? 0, 0));
}

function computeEditMicrodollarCost(usage: EditUsage, provider: ProviderId): number {
  switch (provider) {
    case 'inception': {
      // Inception Mercury Edit 2 published rates (per 1M tokens):
      //   $0.25 input  →  0.25 mUSD/token
      //   $0.025 cached input  →  0.025 mUSD/token
      //   $0.75 output  →  0.75 mUSD/token
      // Sources:
      //   https://www.inceptionlabs.ai/models
      //   https://www.inceptionlabs.ai/blog/introducing-mercury-edit-2
      // Mercury 2 (chat) shares the same per-token rates.
      const cacheHitTokens = getEditCacheHitTokens(usage);
      const uncachedInputTokens = usage.prompt_tokens - cacheHitTokens;
      return Math.round(
        uncachedInputTokens * 0.25 + cacheHitTokens * 0.025 + usage.completion_tokens * 0.75
      );
    }
    default:
      console.error('Unknown provider for edit cost calculation', provider);
      return 0;
  }
}

export function parseEditUsageFromResponse(
  response: string,
  provider: ProviderId,
  statusCode: number
): MicrodollarUsageStats {
  const json = JSON.parse(response) as MercuryEditCompletionResponse;
  const usage = json.usage;
  const cacheHitTokens = usage ? getEditCacheHitTokens(usage) : 0;
  return {
    messageId: json.id ?? null,
    model: json.model ?? null,
    responseContent: json.choices?.[0]?.message?.content || '',
    hasError: !json.model || statusCode >= 400,
    inference_provider: provider,
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    cacheHitTokens,
    cacheWriteTokens: 0,
    cost_mUsd: usage ? computeEditMicrodollarCost(usage, provider) : 0,
    cacheDiscount_mUsd:
      usage && provider === 'inception' ? Math.round(cacheHitTokens * (0.25 - 0.025)) : undefined,
    is_byok: null,
    upstream_id: null,
    finish_reason: null,
    latency: null,
    moderation_latency: null,
    generation_time: null,
    streamed: null,
    cancelled: null,
    status_code: statusCode,
  };
}

export function countAndStoreEditUsage(
  clonedResponse: Response,
  usageContext: MicrodollarUsageContext,
  requestSpan: Span | undefined
) {
  debugSaveProxyResponseStream(clonedResponse, '.log.resp.json');

  const statusCode = usageContext.status_code ?? 0;
  const usageStatsPromise = !clonedResponse.body
    ? Promise.resolve(null)
    : clonedResponse
        .text()
        .then(content => parseEditUsageFromResponse(content, usageContext.provider, statusCode))
        .catch(error => {
          captureException(error, {
            tags: { source: 'edit_usage_processing' },
            extra: { statusCode },
          });
          return null;
        });

  after(
    usageStatsPromise.then(usageStats => {
      requestSpan?.end();
      if (!usageStats) {
        captureMessage('SUSPICIOUS: No edit usage information', {
          level: 'error',
          tags: { source: 'edit_usage_processing' },
          extra: { usageContext },
        });
        return;
      }

      usageStats.market_cost = usageStats.cost_mUsd;

      if (usageContext.is_free || usageContext.user_byok) {
        usageStats.cost_mUsd = 0;
        usageStats.cacheDiscount_mUsd = 0;
      }

      return logMicrodollarUsageAndReportToBouncer(usageStats, usageContext);
    })
  );
}

// ============================================================================
// Embedding-Specific Code
// ============================================================================

type EmbeddingUsage = {
  prompt_tokens: number;
  total_tokens: number;
  cost?: number;
};

type EmbeddingResponse = {
  id?: string;
  object: 'list';
  model: string;
  usage: EmbeddingUsage;
};

type TranscriptionUsage = {
  seconds?: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  cost?: number;
  is_byok?: boolean | null;
  cost_details?: { upstream_inference_cost: number };
};

type TranscriptionResponse = {
  id?: string;
  model?: string;
  text?: string;
  usage?: TranscriptionUsage;
};

export function parseEmbeddingUsageFromResponse(
  responseText: string,
  statusCode: number
): MicrodollarUsageStats {
  const json = JSON.parse(responseText) as EmbeddingResponse;

  // Upstream providers (OpenRouter, Vercel) include cost in USD → convert to microdollars.
  const cost_mUsd = json.usage.cost != null ? toMicrodollars(json.usage.cost) : 0;

  return {
    messageId: json.id ?? null,
    model: json.model,
    responseContent: '',
    hasError: !json.model || statusCode >= 400,
    inference_provider: null,
    inputTokens: json.usage.prompt_tokens,
    outputTokens: 0,
    cacheHitTokens: 0,
    cacheWriteTokens: 0,
    cost_mUsd,
    is_byok: null,
    upstream_id: null,
    finish_reason: null,
    latency: null,
    moderation_latency: null,
    generation_time: null,
    streamed: false,
    cancelled: false,
    status_code: statusCode,
  };
}

export function parseTranscriptionUsageFromResponse(
  responseText: string,
  statusCode: number,
  requestedModel: string
): MicrodollarUsageStats {
  const json = JSON.parse(responseText) as TranscriptionResponse;
  const base = {
    messageId: json.id ?? null,
    model: json.model ?? requestedModel,
    responseContent: json.text ?? '',
    hasError: statusCode >= 400 || typeof json.text !== 'string',
    inference_provider: null,
    upstream_id: null,
    finish_reason: null,
    latency: null,
    moderation_latency: null,
    generation_time: json.usage?.seconds ?? null,
    streamed: false,
    cancelled: false,
    status_code: statusCode,
  };
  const cost = computeOpenRouterCostFields(
    json.usage ?? {},
    base,
    'transcription_usage_processing'
  );

  return {
    ...base,
    inputTokens: json.usage?.input_tokens ?? 0,
    outputTokens: json.usage?.output_tokens ?? 0,
    cacheHitTokens: 0,
    cacheWriteTokens: 0,
    cost_mUsd: cost.cost_mUsd,
    is_byok: cost.is_byok,
  };
}

export function extractEmbeddingPromptInfo(body: { input: unknown }): PromptInfo {
  const inputStr =
    body.input == null
      ? ''
      : typeof body.input === 'string'
        ? body.input
        : Array.isArray(body.input) && typeof body.input[0] === 'string'
          ? body.input[0]
          : JSON.stringify(body.input).slice(0, 100);
  return {
    system_prompt_prefix: '',
    system_prompt_length: 0,
    user_prompt_prefix: inputStr.slice(0, 100),
  };
}

export function countAndStoreEmbeddingUsage(
  clonedResponse: Response,
  usageContext: MicrodollarUsageContext,
  requestSpan: Span | undefined
) {
  debugSaveProxyResponseStream(clonedResponse, '.log.resp.json');

  const statusCode = usageContext.status_code ?? 0;
  const usageStatsPromise = !clonedResponse.body
    ? Promise.resolve(null)
    : clonedResponse
        .text()
        .then(text => parseEmbeddingUsageFromResponse(text, statusCode))
        .catch(() => null);

  after(
    usageStatsPromise.then(usageStats => {
      requestSpan?.end();
      if (!usageStats) {
        captureMessage('SUSPICIOUS: No embedding usage information', {
          level: 'error',
          tags: { source: 'embedding_usage_processing' },
          extra: { usageContext },
        });
        return;
      }

      // Preserve the real upstream cost before free-model or BYOK zeroing.
      usageStats.market_cost = usageStats.cost_mUsd;

      if (usageContext.is_free || usageContext.user_byok) {
        usageStats.cost_mUsd = 0;
      }

      return logMicrodollarUsageAndReportToBouncer(usageStats, usageContext);
    })
  );
}

export function countAndStoreTranscriptionUsage(
  clonedResponse: Response,
  usageContext: MicrodollarUsageContext,
  requestSpan: Span | undefined
) {
  debugSaveProxyResponseStream(clonedResponse, '.log.resp.json');

  const statusCode = usageContext.status_code ?? 0;
  const usageStatsPromise = !clonedResponse.body
    ? Promise.resolve(null)
    : clonedResponse
        .text()
        .then(text =>
          parseTranscriptionUsageFromResponse(text, statusCode, usageContext.requested_model)
        )
        .catch(() => null);

  after(
    usageStatsPromise.then(usageStats => {
      requestSpan?.end();
      if (!usageStats) {
        captureMessage('SUSPICIOUS: No transcription usage information', {
          level: 'error',
          tags: { source: 'transcription_usage_processing' },
          extra: { usageContext },
        });
        return;
      }

      return processTokenData(usageStats, usageContext);
    })
  );
}

// ============================================================================
// Proxied Chat Completion Helper
// ============================================================================

export type ProxiedChatCompletionRequest = {
  authToken: string;
  version: string;
  userAgent: string;
  body: OpenRouterChatCompletionRequest;
  organizationId?: string;
  /** Feature attribution value for microdollar usage tracking. */
  feature?: FeatureValue;
};

export type ProxiedChatCompletionResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string };

/**
 * Send a non-streaming chat completion request through the internal proxy endpoint.
 * This is useful for server-side code that needs to make LLM requests (e.g., Slack bot).
 */
export async function sendProxiedChatCompletion<T>(
  request: ProxiedChatCompletionRequest
): Promise<ProxiedChatCompletionResult<T>> {
  const headers = new Headers({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${request.authToken}`,
    'X-KiloCode-Version': request.version,
    'User-Agent': request.userAgent,
  });

  if (request.organizationId) {
    headers.set('X-KiloCode-OrganizationId', request.organizationId);
  }

  if (request.feature) {
    headers.set(FEATURE_HEADER, request.feature);
  }

  const response = await fetch(`${APP_URL}/api/openrouter/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ...request.body,
      stream: false,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    return { ok: false, status: response.status, error: errorText };
  }

  const data = (await response.json()) as T;
  return { ok: true, data };
}
