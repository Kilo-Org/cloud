import { api_request_log, type User } from '@kilocode/db/schema';
import { detectToolCallArgumentErrors } from '@kilocode/web-shared/lib/ai-gateway/api-request-log-errors';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import { getReasoningEffort } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/request-helpers';
import type {
  ProviderId,
  ProviderResponseTransforms,
} from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { getCustomPricingConfig } from '@kilocode/web-shared/lib/ai-gateway/custom-pricing-config';
import { getDynamicRequestLoggingMode } from '@kilocode/web-shared/lib/ai-gateway/request-logging-opt-ins';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { logExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { sanitizeJsonbValue } from '@kilocode/web-shared/lib/sanitize-jsonb';
import { uploadApiRequestLogBlobs } from '@kilocode/web-shared/lib/r2/api-request-log';
import { after, type NextResponse } from 'next/server';
import type {
  RequestLogCapture,
  ResponseUsageContext,
} from '@kilocode/web-shared/lib/ai-gateway/rewriteModelResponse.shared';
import { rewriteModelResponse_ChatCompletions } from '@kilocode/web-shared/lib/ai-gateway/rewriteModelResponse.chatCompletions';
import { rewriteModelResponse_Messages } from '@kilocode/web-shared/lib/ai-gateway/rewriteModelResponse.messages';
import { rewriteModelResponse_Responses } from '@kilocode/web-shared/lib/ai-gateway/rewriteModelResponse.responses';

export type RequestLoggingParams = {
  user: User | null;
  organization_id: string | null;
  session_id: string | null;
  vercel_request_id: string | null;
  request: GatewayRequest;
};

export type LogUnrewrittenResponseParams = {
  response: Response;
  model: string;
  providerId: ProviderId;
  logging: RequestLoggingParams;
  /** Merged into the row's `error`, e.g. to mark a response the gateway produced itself. */
  error?: Record<string, string>;
};

export type RewriteModelResponseParams = {
  response: Response;
  model: string;
  providerId: ProviderId;
  kind: GatewayRequest['kind'];
  isFree: boolean;
  userByok: boolean;
  logging: RequestLoggingParams;
  responseTransforms: ProviderResponseTransforms | null;
};

type CapturedResponseBody =
  | { text: string; readError?: never }
  | { readError: string; text?: string };

export function redactApiRequestLogRequest(request: GatewayRequest): unknown {
  const gateway = request.body.providerOptions?.gateway;
  if (!gateway?.byok) {
    return request.body;
  }

  const redactedByok = Object.fromEntries(
    Object.entries(gateway.byok).map(([provider, credentials]) => [
      provider,
      credentials.map(() => ({ apiKey: '[redacted]' })),
    ])
  );

  return {
    ...request.body,
    providerOptions: {
      ...request.body.providerOptions,
      gateway: { ...gateway, byok: redactedByok },
    },
  };
}

async function createRequestLogCapture(
  response: Response,
  model: string,
  provider: string,
  logging: RequestLoggingParams,
  extraError?: Record<string, string>
): Promise<RequestLogCapture | null> {
  const { user, organization_id, session_id, vercel_request_id, request } = logging;
  const loggingMode = await getDynamicRequestLoggingMode({
    accountId: user?.id ?? null,
    organizationId: organization_id,
  });
  if (loggingMode === null) {
    return null;
  }
  const status = response.status;

  let resolveCaptured: (result: CapturedResponseBody) => void = () => {};
  const captured = new Promise<CapturedResponseBody>(resolve => {
    resolveCaptured = resolve;
  });
  let isSettled = false;
  const settleOnce = (result: CapturedResponseBody) => {
    if (!isSettled) {
      isSettled = true;
      resolveCaptured(result);
    }
  };

  after(async () => {
    // Wait until the response pipeline has processed the response body. This
    // resolves when the response stream completes (or fails), which happens
    // before after() callbacks are awaited.
    const result = await captured;
    const responseText = 'text' in result ? result.text : undefined;
    const responseReadError = 'readError' in result ? result.readError : undefined;
    if (responseReadError !== undefined) {
      logExceptInTest(
        `[rewriteModelResponse] failed to read response body (user=${user?.id}, status=${status}, model=${model}): ${responseReadError}`
      );
    }
    try {
      const responseError =
        responseText !== undefined
          ? responseReadError !== undefined
            ? {
                ...(detectToolCallArgumentErrors(responseText, request) ?? {}),
                response_body_read_error: responseReadError,
              }
            : detectToolCallArgumentErrors(responseText, request)
          : { response_body_read_error: responseReadError };
      const detectedError =
        extraError === undefined ? responseError : { ...(responseError ?? {}), ...extraError };
      if (loggingMode === 'errors_only' && status < 400 && detectedError === null) {
        return;
      }
      const { columns: blobColumns, uploadError } = await uploadApiRequestLogBlobs({
        request: JSON.stringify(redactApiRequestLogRequest(request)),
        response: responseText,
      });
      const r2UploadError = uploadError?.substring(0, 4000);
      if (r2UploadError !== undefined) {
        logExceptInTest(
          `[rewriteModelResponse] failed to upload api_request_log blobs to R2 (user=${user?.id}, status=${status}, model=${model}): ${r2UploadError}`
        );
      }
      const error =
        r2UploadError === undefined
          ? detectedError
          : { ...(detectedError ?? {}), r2_upload_error: r2UploadError };
      const apiRequestLogId = await db
        .insert(api_request_log)
        .values({
          kilo_user_id: user?.id,
          organization_id,
          session_id,
          vercel_request_id,
          status_code: status,
          model,
          provider,
          error: sanitizeJsonbValue(error),
          ...blobColumns,
        })
        .returning({ id: api_request_log.id });
      logExceptInTest(
        '[rewriteModelResponse] Inserted into api_request_log',
        apiRequestLogId[0].id
      );
    } catch (e) {
      const cause = e instanceof Error ? e.cause : undefined;
      logExceptInTest(
        `[rewriteModelResponse] failed to insert api_request_log (user=${user?.id}, status=${status}, model=${model}) cause (truncated): ${String(cause).substring(0, 4000)} error (truncated): ${String(e).substring(0, 4000)}`
      );
    }
  });

  return {
    setBody: text => settleOnce({ text }),
    setReadError: (error, partialBody) =>
      settleOnce(
        partialBody !== undefined && partialBody.length > 0
          ? { text: partialBody, readError: String(error).substring(0, 4000) }
          : { readError: String(error).substring(0, 4000) }
      ),
  };
}

/** For paths where the upstream response is not passed through rewriteModelResponse. */
export async function logUnrewrittenResponse({
  response,
  model,
  providerId,
  logging,
  error,
}: LogUnrewrittenResponseParams): Promise<void> {
  const capture = await createRequestLogCapture(response, model, providerId, logging, error);
  if (!capture) {
    return;
  }
  try {
    capture.setBody(await response.text());
  } catch (error) {
    capture.setReadError(error);
  }
}

export async function rewriteModelResponse({
  response,
  model,
  providerId,
  kind,
  isFree,
  userByok,
  logging,
  responseTransforms,
}: RewriteModelResponseParams): Promise<NextResponse> {
  const capture = await createRequestLogCapture(response, model, providerId, logging);
  const usageContext: ResponseUsageContext = {
    requested_model: model,
    provider: providerId,
    api_kind: kind,
    is_free: isFree,
    user_byok: userByok,
    custom_pricing_config: await getCustomPricingConfig(),
  };

  console.debug('[rewriteModelResponse] rewriting response for %s', model);
  const { vercel_request_id: vercelRequestId } = logging;
  const reasoningEffort = getReasoningEffort(logging.request);
  if (kind === 'chat_completions') {
    return rewriteModelResponse_ChatCompletions({
      response,
      usageContext,
      capture,
      reasoningEffort,
      vercelRequestId,
      responseTransforms,
    });
  }
  if (kind === 'responses') {
    return rewriteModelResponse_Responses({
      response,
      usageContext,
      capture,
      reasoningEffort,
      vercelRequestId,
    });
  }
  if (kind === 'messages') {
    return rewriteModelResponse_Messages({
      response,
      usageContext,
      capture,
      reasoningEffort,
      vercelRequestId,
    });
  }

  const error = new Error(`implementation error: unrecognized API kind ${kind}`);
  capture?.setReadError(error);
  throw error;
}
