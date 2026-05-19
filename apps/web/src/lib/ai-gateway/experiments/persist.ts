import { captureException, captureMessage } from '@sentry/nextjs';
import { db } from '@/lib/drizzle';
import { model_experiment_request } from '@kilocode/db/schema';
import { putPromptIfAbsent } from '@/lib/r2/experiment-prompts';
import type { ExperimentPromptCapture } from '@/lib/ai-gateway/processUsage.types';
import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';

/**
 * Sentinel values written to `model_experiment_request.system_prompt_sha256` /
 * `request_body_sha256` instead of a real 64-char hex digest. See the schema
 * CHECK constraints and `.plans/experimental-models-1.md` "Prompt Storage".
 */
export const PROMPT_HASH_ABSENT = '__absent__';
export const PROMPT_HASH_FAILED = '__failed__';
export const PROMPT_HASH_DELETED = '__deleted__';

/** 4 MB. Comfortably above any current 1M-token-context request. */
export const SYSTEM_PROMPT_CAP_BYTES = 4 * 1024 * 1024;
export const REQUEST_BODY_CAP_BYTES = 4 * 1024 * 1024;

/**
 * Build a bounded capture of the canonical post-`transformRequest` upstream
 * request body, split into the leading system message and the remainder.
 *
 * - chat_completions: extracts a single leading `role === 'system'` message
 *   into `systemPromptContent` and serializes the remainder
 *   (`{...body, messages: nonSystem}`) into `requestBodyContent`.
 * - messages / responses: leaves the full body in `requestBodyContent` and
 *   leaves `systemPromptContent` null. The provider-specific system field
 *   (e.g. anthropic `body.system`) is captured as part of the body blob.
 *
 * The 4 MB caps ensure we never retain unbounded data through the async
 * `after()` path. If either side exceeds its cap, it is tail-truncated
 * deterministically and `wasTruncated` is set to true.
 */
export function buildExperimentPromptCapture(request: GatewayRequest): ExperimentPromptCapture {
  let wasTruncated = false;

  if (request.kind === 'chat_completions') {
    const messages = Array.isArray(request.body.messages) ? request.body.messages : [];
    let systemContent: string | null = null;
    let nonSystemMessages = messages;
    if (messages.length > 0 && messages[0]?.role === 'system') {
      systemContent = serialize(messages[0].content ?? '');
      nonSystemMessages = messages.slice(1);
    }
    const remainder = { ...request.body, messages: nonSystemMessages };
    let bodyContent = serialize(remainder);
    if (systemContent !== null && systemContent.length > SYSTEM_PROMPT_CAP_BYTES) {
      systemContent = systemContent.slice(0, SYSTEM_PROMPT_CAP_BYTES);
      wasTruncated = true;
    }
    if (bodyContent.length > REQUEST_BODY_CAP_BYTES) {
      bodyContent = bodyContent.slice(0, REQUEST_BODY_CAP_BYTES);
      wasTruncated = true;
    }
    if (wasTruncated) {
      noteTruncation(request.body.model);
    }
    return {
      systemPromptContent: systemContent,
      requestBodyContent: bodyContent,
      wasTruncated,
    };
  }

  // messages / responses: fold the entire serialized body into the body
  // side; system extraction for those API kinds is left for later if it
  // turns out to dedup meaningfully.
  let bodyContent = serialize(request.body);
  if (bodyContent.length > REQUEST_BODY_CAP_BYTES) {
    bodyContent = bodyContent.slice(0, REQUEST_BODY_CAP_BYTES);
    wasTruncated = true;
    noteTruncation(request.body.model);
  }
  return {
    systemPromptContent: null,
    requestBodyContent: bodyContent,
    wasTruncated,
  };
}

function serialize(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function noteTruncation(model: string | undefined) {
  // Sentry breadcrumb only (no payload content) — we want to know if this
  // ever fires at non-trivial rates so we can re-evaluate caps.
  captureMessage('Experiment prompt capture truncated', {
    level: 'info',
    tags: { source: 'model-experiments', operation: 'buildExperimentPromptCapture' },
    extra: { model: model ?? null },
  });
}

export type PersistExperimentAttributionInput = {
  usageId: string;
  createdAt: string;
  variantVersionId: string;
  allocationSubject: 'user' | 'machine' | 'ip';
  clientRequestId: string | null;
  capture: ExperimentPromptCapture | null;
};

/**
 * Insert one row into `model_experiment_request` for an experimented
 * request. Best-effort R2 puts run in parallel; only the failed side
 * gets `__failed__`.
 *
 * Failures here MUST NOT roll back the microdollar usage write. Errors
 * are reported to Sentry and swallowed.
 */
export async function persistExperimentAttribution(
  input: PersistExperimentAttributionInput
): Promise<void> {
  try {
    const { systemHash, bodyHash } = await storePrompts(input.capture);
    await db.insert(model_experiment_request).values({
      usage_id: input.usageId,
      variant_version_id: input.variantVersionId,
      allocation_subject: input.allocationSubject,
      client_request_id: input.clientRequestId,
      system_prompt_sha256: systemHash,
      request_body_sha256: bodyHash,
      was_truncated: input.capture?.wasTruncated ?? false,
      created_at: input.createdAt,
    });
  } catch (err) {
    captureException(err, {
      tags: { source: 'model-experiments', operation: 'persistExperimentAttribution' },
      extra: { usageId: input.usageId, variantVersionId: input.variantVersionId },
    });
  }
}

async function storePrompts(
  capture: ExperimentPromptCapture | null
): Promise<{ systemHash: string; bodyHash: string }> {
  if (!capture) {
    return { systemHash: PROMPT_HASH_ABSENT, bodyHash: PROMPT_HASH_FAILED };
  }
  const systemPromise =
    capture.systemPromptContent === null
      ? Promise.resolve<PromptSlotResult>({ kind: 'absent' })
      : putPromptSafely(capture.systemPromptContent);
  const bodyPromise = putPromptSafely(capture.requestBodyContent);
  const [systemResult, bodyResult] = await Promise.allSettled([systemPromise, bodyPromise]);
  return {
    systemHash: resolveHash(systemResult, 'system'),
    bodyHash: resolveHash(bodyResult, 'body'),
  };
}

type PromptSlotResult = { kind: 'absent' } | { kind: 'sha'; sha: string } | { kind: 'failed' };

async function putPromptSafely(content: string): Promise<PromptSlotResult> {
  try {
    return { kind: 'sha', sha: await putPromptIfAbsent(content) };
  } catch (err) {
    captureException(err, {
      tags: { source: 'model-experiments', operation: 'putPromptIfAbsent' },
    });
    return { kind: 'failed' };
  }
}

function resolveHash(
  settled: PromiseSettledResult<PromptSlotResult>,
  side: 'system' | 'body'
): string {
  if (settled.status === 'rejected') {
    captureException(settled.reason, {
      tags: { source: 'model-experiments', operation: 'storePrompts', side },
    });
    return PROMPT_HASH_FAILED;
  }
  const result = settled.value;
  if (result.kind === 'absent') return PROMPT_HASH_ABSENT;
  if (result.kind === 'sha') return result.sha;
  return PROMPT_HASH_FAILED;
}
