import type { Provider } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import type { SendUpstreamAttemptResult } from '@kilocode/web-shared/lib/ai-gateway/providers/upstream-attempt';
import {
  peekUpstreamStreamForContent,
  type PeekUpstreamStreamOptions,
  type UpstreamStreamPeekOutcome,
} from '@kilocode/web-shared/lib/ai-gateway/upstream-stream-peek';
import { logExceptInTest, warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { z } from 'zod';

/**
 * A streaming chat completions answer that carries no content is a usable failure: the client
 * received a 200 and no delta, so it re-sends the same prompt. This module names that class in the
 * log for every stream, and, for the models listed in `GATEWAY_EMPTY_STREAM_RETRY_MODELS`, repeats
 * the upstream request once with the provider that produced the empty answer demoted.
 */

export const EMPTY_STREAM_RETRY_MODELS_ENV = 'GATEWAY_EMPTY_STREAM_RETRY_MODELS';

type SuccessfulAttempt = Extract<SendUpstreamAttemptResult, { type: 'success' }>;

export type EmptyStreamRetryOutcome =
  | 'error'
  | 'not-attempted'
  | 'unknown'
  | UpstreamStreamPeekOutcome;

export type EmptyStreamObservation = {
  events: number;
  generationId: string | undefined;
  provider: string | undefined;
  retried: boolean;
  retryOutcome: EmptyStreamRetryOutcome;
};

export type MaybeRetryEmptyStreamInput = {
  attempt: SuccessfulAttempt;
  /** Whether this model may be retried; see `isEmptyStreamRetryEnabled`. */
  enabled: boolean;
  /** The peek reads chat completion deltas, so other API shapes are forwarded unread. */
  kind: GatewayRequest['kind'];
  model: string;
  peekOptions?: PeekUpstreamStreamOptions;
  providerType: Provider['type'];
  /**
   * A copy of the request as it was before provider transforms mutated it, or null when the caller
   * did not keep one because the retry is disabled for this request.
   */
  requestForRetry: GatewayRequest | null;
  retry: (request: GatewayRequest) => Promise<SendUpstreamAttemptResult>;
  vercelRequestId: string | null | undefined;
};

export type MaybeRetryEmptyStreamResult = {
  attempt: SuccessfulAttempt;
  /** Null unless the first answer was content-free. */
  emptyStream: EmptyStreamObservation | null;
  /** The request as sent for the answer in `attempt`, when it differs from the caller's. */
  request: GatewayRequest | null;
};

const modelEntrySchema = z
  .string()
  .min(1)
  .regex(/^[\w./:*@~-]+$/);
const modelEntriesSchema = z.array(modelEntrySchema);

/**
 * Parses the retry allowlist. Entries are model ids, or prefixes when they end in `*`, matched
 * case-insensitively. An unset or invalid value disables the retry, which is the default.
 */
export function parseEmptyStreamRetryModels(raw: string | null | undefined): readonly string[] {
  if (!raw) return [];
  const entries = raw
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
  if (entries.length === 0) return [];
  const parsed = modelEntriesSchema.safeParse(entries);
  if (!parsed.success) {
    warnExceptInTest(
      `[ai-gateway] ignoring an unreadable ${EMPTY_STREAM_RETRY_MODELS_ENV} value; empty stream retry stays off`
    );
    return [];
  }
  return [...new Set(parsed.data.map(entry => entry.toLowerCase()))];
}

export function isEmptyStreamRetryModelListed(model: string, models: readonly string[]): boolean {
  const normalized = model.toLowerCase();
  return models.some(entry =>
    entry.endsWith('*') ? normalized.startsWith(entry.slice(0, -1)) : normalized === entry
  );
}

let cachedModelsEnv: string | null | undefined;
let cachedModels: readonly string[] = [];

/**
 * The configured allowlist, parsed once per distinct environment value. An operator changing the
 * variable takes effect for new requests without a redeploy of another kind.
 */
export function getEmptyStreamRetryModels(): readonly string[] {
  const raw = process.env[EMPTY_STREAM_RETRY_MODELS_ENV] ?? null;
  if (raw !== cachedModelsEnv) {
    cachedModelsEnv = raw;
    cachedModels = parseEmptyStreamRetryModels(raw);
  }
  return cachedModels;
}

export type EmptyStreamRetryEligibility = {
  /** Whether the request carries a bounded-spend header. Each attempt spends the same envelope. */
  costLimited: boolean;
  kind: GatewayRequest['kind'];
  model: string;
  models: readonly string[];
  streaming: boolean;
  /** A user's own key pays for the retry, so the retry is never sent for it. */
  userByok: boolean;
};

/**
 * Every condition the retry needs. `chat_completions` only: the peek reads chat completion deltas,
 * and a retry of another API shape would be classified by a definition that does not describe it.
 */
export function isEmptyStreamRetryEnabled(input: EmptyStreamRetryEligibility): boolean {
  return (
    input.kind === 'chat_completions' &&
    input.streaming &&
    !input.userByok &&
    !input.costLimited &&
    isEmptyStreamRetryModelListed(input.model, input.models)
  );
}

/**
 * The configured order entry that names the provider a stream reported. The stream reports a
 * display name while `provider.order` holds endpoint slugs, so both sides are reduced to letters
 * and digits before comparison.
 */
function configuredSlugForReportedProvider(
  order: readonly string[] | undefined,
  reported: string
): string | undefined {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = normalize(reported);
  if (target.length < 3) return undefined;
  return order?.find(entry => {
    const candidate = normalize(entry);
    return candidate.length >= 3 && target.startsWith(candidate);
  });
}

/**
 * Demotes the provider that produced the empty answer, so OpenRouter routes the retry elsewhere.
 * The gateway's configured order still applies; this only removes one endpoint from it, and only
 * when the reported provider is one of its entries.
 */
function demoteFailedProvider(
  request: GatewayRequest,
  providerType: Provider['type'],
  failedProvider: string | undefined
) {
  if (providerType !== 'openrouter' || !failedProvider) return;
  const provider = request.body.provider;
  // `only` is the caller's hard restriction; adding an exclusion to it can leave no route at all.
  if (provider?.only && provider.only.length > 0) return;
  const slug = configuredSlugForReportedProvider(provider?.order, failedProvider);
  if (!slug) return;
  request.body.provider = {
    ...provider,
    ignore: [...new Set([...(provider?.ignore ?? []), slug])],
  };
}

/**
 * Names one content-free answer in the log, whether or not it was retried. The rate of this line is
 * the class's denominator; the retry, its provider, and its outcome make the retry's effect
 * countable per model.
 */
export function logEmptyUpstreamStream(input: {
  emptyStream: EmptyStreamObservation;
  model: string;
  providerType: Provider['type'];
  vercelRequestId: string | null | undefined;
}) {
  logExceptInTest(
    '[ai-gateway] upstream stream ended without content: model %s, retry outcome: %s',
    input.model,
    input.emptyStream.retryOutcome,
    {
      events: input.emptyStream.events,
      generationId: input.emptyStream.generationId,
      model: input.model,
      provider: input.emptyStream.provider ?? '<unknown>',
      providerType: input.providerType,
      retried: input.emptyStream.retried,
      retryOutcome: input.emptyStream.retryOutcome,
      vercelRequestId: input.vercelRequestId ?? '<none>',
    }
  );
}

/**
 * Peeks the first answer, and retries it once when it carried no content and the request is
 * eligible. A retry is only adopted when it produced content; anything else forwards the first
 * answer unchanged, so the client sees exactly what it sees today.
 */
export async function maybeRetryEmptyUpstreamStream(
  input: MaybeRetryEmptyStreamInput
): Promise<MaybeRetryEmptyStreamResult> {
  if (input.kind !== 'chat_completions') {
    return { attempt: input.attempt, emptyStream: null, request: null };
  }
  const peeked = await peekUpstreamStreamForContent(input.attempt.response, input.peekOptions);
  const firstAttempt: SuccessfulAttempt = { ...input.attempt, response: peeked.response };
  if (peeked.outcome !== 'empty') {
    return { attempt: firstAttempt, emptyStream: null, request: null };
  }

  let retried = false;
  let retryOutcome: EmptyStreamRetryOutcome = 'not-attempted';
  let attempt = firstAttempt;
  let request: GatewayRequest | null = null;
  // A retry needs a copy taken before provider transforms; without one the answer forwards.
  const requestForRetry = input.enabled ? input.requestForRetry : null;
  if (requestForRetry) {
    retried = true;
    demoteFailedProvider(requestForRetry, input.providerType, peeked.provider);
    const retryAttempt = await input.retry(requestForRetry);
    if (retryAttempt.type === 'success') {
      const retryPeeked = await peekUpstreamStreamForContent(
        retryAttempt.response,
        input.peekOptions
      );
      retryOutcome = retryPeeked.outcome;
      if (retryPeeked.outcome !== 'empty') {
        attempt = { ...retryAttempt, response: retryPeeked.response };
        request = requestForRetry;
        // The first answer is replaced, so its body must be released rather than left unread.
        await firstAttempt.response.body?.cancel();
      } else {
        await retryPeeked.response.body?.cancel();
      }
    } else {
      retryOutcome = 'error';
    }
  }

  const emptyStream: EmptyStreamObservation = {
    events: peeked.events,
    generationId: peeked.generationId,
    provider: peeked.provider,
    retried,
    retryOutcome,
  };
  logEmptyUpstreamStream({
    emptyStream,
    model: input.model,
    providerType: input.providerType,
    vercelRequestId: input.vercelRequestId,
  });
  return { attempt, emptyStream, request };
}
