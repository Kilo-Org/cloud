import { after, type NextResponse as NextResponseType } from 'next/server';
import type { Span } from '@sentry/nextjs';
import type { User } from '@kilocode/db';
import { applyUpstreamErrorPolicy } from '@kilocode/web-shared/lib/ai-gateway/upstream-error-policy';
import { REPLACED_ANSWER_HEADER } from '@kilocode/web-shared/lib/ai-gateway/replaced-answer-header';
import { recordBriefingUsage } from '@kilocode/web-shared/lib/agent-briefing-usage';
import type { sendUpstreamAttempt } from '@kilocode/web-shared/lib/ai-gateway/providers/upstream-attempt';
import type { GetProviderProviderResult } from '@kilocode/web-shared/lib/ai-gateway/providers/get-provider';
import {
  accountForMicrodollarUsage,
  extractInferenceRegion,
  makeErrorReadable,
} from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';
import {
  logUnrewrittenResponse,
  rewriteModelResponse,
  type RequestLoggingParams,
} from '@kilocode/web-shared/lib/ai-gateway/rewriteModelResponse';
import { isAnonymousContext, type AnonymousUserContext } from '@kilocode/web-shared/lib/anonymous';
import { emitApiMetricsForResponse } from '@kilocode/web-shared/lib/ai-gateway/o11y/api-metrics.server';
import { normalizeModelId } from '@kilocode/web-shared/lib/ai-gateway/model-utils';
import type { MicrodollarUsageContext } from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
import { errorExceptInTest, logExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import {
  guardEnkryptOutput,
  type EnkryptOutputScan,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/output-guardrail';
import type { EnkryptOutputGuardrailReport } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/report';

type RespondInput = {
  upstream: Extract<Awaited<ReturnType<typeof sendUpstreamAttempt>>, { type: 'success' }>;
  /** The request as sent upstream; provider transforms may have removed its model. */
  request: GatewayRequest;
  /** The resolved model id, lowercased. */
  model: string;
  /** The model id the caller asked for, lowercased. */
  requestedModel: string;
  providerResult: GetProviderProviderResult;
  user: User | AnonymousUserContext;
  organizationId: string | undefined;
  usageContext: MicrodollarUsageContext;
  upstreamSpan: Span;
  requestStartedAt: number;
  briefingSettlementToken: string | null;
  logging: RequestLoggingParams;
  /** Null when the organization has no output guardrail. */
  enkryptOutputScan: EnkryptOutputScan | null;
  signal: AbortSignal;
  captureEnkryptOutputReport: (report: () => Promise<EnkryptOutputGuardrailReport>) => void;
};

/**
 * Turns a successful upstream attempt into the client response: emits metrics, applies the
 * upstream error policy, starts usage accounting, applies the organization's output guardrail,
 * and rewrites the response for the client.
 */
export async function respondToUpstream(input: RespondInput): Promise<NextResponseType<unknown>> {
  const { upstream, request, model, providerResult, user, organizationId, usageContext } = input;
  const { response } = upstream;
  const provider = providerResult.provider;
  logExceptInTest(
    'upstream response status: %s, x-vercel-id: %s, session_id: %s',
    response.status,
    response.headers.get('x-vercel-id') || '<none>',
    usageContext.session_id || '<none>'
  );

  emitApiMetricsForResponse(
    {
      kiloUserId: user.id,
      organizationId,
      isAnonymous: isAnonymousContext(user),
      isStreaming: request.body.stream === true,
      userByok: usageContext.user_byok,
      mode: usageContext.mode || undefined,
      provider: provider.type,
      requestedModel: input.requestedModel,
      resolvedModel: normalizeModelId(model),
      toolsAvailable: upstream.toolsAvailable,
      toolsUsed: upstream.toolsUsed,
      ttfbMs: Math.max(0, Math.round(performance.now() - input.requestStartedAt)),
      statusCode: response.status,
    },
    response.clone(),
    input.requestStartedAt
  );
  usageContext.status_code = response.status;
  usageContext.inference_region = extractInferenceRegion(request.body);
  const userByokProviderIds = providerResult.userByok?.map(byok => byok.providerId) ?? null;

  const upstreamErrorResponse = await applyUpstreamErrorPolicy({
    response,
    providerId: provider.type,
    isUserByok: usageContext.user_byok,
    user,
    request: request.body,
    organizationId,
    model: request.body.model ?? model,
    gatewayModel: model,
    byokProviderIds: userByokProviderIds,
  });
  if (upstreamErrorResponse) return upstreamErrorResponse;

  // Reading the body is side-effectful, so accounting reads a clone.
  const accounting = accountForMicrodollarUsage(
    response.clone(),
    usageContext,
    input.upstreamSpan,
    provider
  );
  // This answer is now accounted, so a decline that replaces it may already be
  // charged. `x-should-retry` describes the replacement's own condition, such as an
  // unavailable output guardrail, not the charge: the marker is what tells a client
  // that a repeat can pay for the same generation twice. A decline of an upstream
  // error is not marked, because that error carries no usage to charge again.
  const answered = response.ok;
  const declineAfterAnswer = <T extends Response>(replacement: T): T => {
    if (answered && !replacement.ok) replacement.headers.set(REPLACED_ANSWER_HEADER, 'true');
    return replacement;
  };
  const settlementToken = input.briefingSettlementToken;
  const sessionId = usageContext.session_id;
  if (
    settlementToken &&
    !isAnonymousContext(user) &&
    !usageContext.isStreaming &&
    usageContext.auto_model === null &&
    sessionId?.startsWith('agent-briefing:') &&
    usageContext.clientRequestId === sessionId
  ) {
    after(
      accounting
        .then(usage =>
          recordBriefingUsage({
            kiloUserId: user.id,
            organizationId,
            generationId: sessionId,
            settlementToken,
            usage,
          })
        )
        .catch(() => {
          errorExceptInTest('Briefing accounting receipt could not be stored');
        })
    );
  }

  const errorResponse = await makeErrorReadable({
    provider: provider.type,
    requestedModel: model,
    request,
    response,
    userByokProviderIds,
  });
  if (errorResponse) {
    await logUnrewrittenResponse({
      response,
      model,
      providerId: provider.type,
      logging: input.logging,
      error: null,
    });
    return declineAfterAnswer(errorResponse);
  }

  let outputRequestLogs: RequestLoggingParams['enkrypt'];
  const logging: RequestLoggingParams = {
    ...input.logging,
    enkrypt: async captureResponse => {
      const [inputLogs, outputLogs] = await Promise.all([
        input.logging.enkrypt?.(captureResponse),
        outputRequestLogs?.(captureResponse),
      ]);
      return [...(inputLogs ?? []), ...(outputLogs ?? [])];
    },
  };
  return declineAfterAnswer(
    await guardEnkryptOutput({
      response,
      scan: input.enkryptOutputScan,
      kind: request.kind,
      stream: usageContext.isStreaming,
      signal: input.signal,
      release: released =>
        rewriteModelResponse({
          response: released,
          model,
          providerId: provider.type,
          kind: request.kind,
          isFree: usageContext.is_free,
          userByok: usageContext.user_byok,
          customLlmPricing: usageContext.custom_llm_pricing,
          logging,
          responseTransforms: provider.responseTransforms,
        }),
      captureReport: input.captureEnkryptOutputReport,
      captureRequestLogs: logs => {
        outputRequestLogs = logs;
      },
      onReject: async (rejection, verdict) => {
        if (input.signal.aborted) return;
        await logUnrewrittenResponse({
          response: rejection.clone(),
          model,
          providerId: provider.type,
          logging,
          error: { guardrail_rejection: verdict.action, guardrail: 'output' },
        });
      },
    })
  );
}
