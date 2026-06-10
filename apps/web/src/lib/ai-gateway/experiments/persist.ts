import { captureException } from '@sentry/nextjs';
import { db } from '@/lib/drizzle';
import { model_experiment_request } from '@kilocode/db/schema';
import { putPromptOrNull } from '@/lib/r2/experiment-prompts';
import type { ExperimentPromptCapture } from '@/lib/ai-gateway/processUsage.types';
import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';

/**
 * Sentinel values written to `model_experiment_request.request_body_sha256`
 * instead of a real 64-char hex digest. The schema CHECK constraint accepts
 * either a 64-char lowercase hex digest or one of these sentinels.
 *
 * - `__failed__`: R2 storage failed; the attribution row still lands.
 * - `__deleted__`: prompt content intentionally wiped while retaining
 *   experiment attribution.
 */
export const PROMPT_HASH_FAILED = '__failed__';
export const PROMPT_HASH_DELETED = '__deleted__';

/** 4 MB measured as UTF-8 bytes (matching what `putPromptIfAbsent` actually
 *  uploads). Comfortably above any current 1M-token-context request. */
export const REQUEST_BODY_CAP_BYTES = 4 * 1024 * 1024;

/**
 * Tail-truncates a string to at most `maxBytes` UTF-8 bytes, stepping back
 * to a UTF-8 codepoint boundary so the result is always valid UTF-8.
 *
 * `string.length` would have measured UTF-16 code units, which under-counts
 * non-ASCII content by up to 4× when encoded as UTF-8 — a 4 MB code-unit
 * cap on CJK content can balloon to ~12 MB on the wire. Slicing UTF-16
 * code units could also split surrogate pairs and produce U+FFFD on encode,
 * making the resulting hash non-deterministic across runtimes.
 */
export function truncateToUtf8Bytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  // UTF-8 continuation bytes have the form 0b10xxxxxx. Walk backward from
  // `maxBytes` until we land on a non-continuation byte (a codepoint
  // start), then slice at that boundary.
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

/**
 * Build a bounded capture of the canonical post-`transformRequest` upstream
 * request body. The full serialized body is content-addressed as a single
 * blob; the upstream API shape (`chat_completions` / `messages` /
 * `responses`) is recorded on `requestKind` so downstream reporting can
 * tell what was sent without re-parsing.
 *
 * The 4 MB cap ensures we never retain unbounded data through the async
 * `after()` path. If the body exceeds the cap it is tail-truncated
 * deterministically and `wasTruncated` is set to true.
 */
export function buildExperimentPromptCapture(request: GatewayRequest): ExperimentPromptCapture {
  let bodyContent = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
  let wasTruncated = false;
  if (Buffer.byteLength(bodyContent, 'utf8') > REQUEST_BODY_CAP_BYTES) {
    bodyContent = truncateToUtf8Bytes(bodyContent, REQUEST_BODY_CAP_BYTES);
    wasTruncated = true;
  }
  return {
    requestKind: request.kind,
    requestBodyContent: bodyContent,
    wasTruncated,
  };
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
 * request. The R2 put is best-effort; on failure we still write the
 * attribution row with `__failed__` as the body hash.
 *
 * Failures here MUST NOT roll back the microdollar usage write. Errors
 * are reported to Sentry and swallowed.
 */
export async function persistExperimentAttribution(
  input: PersistExperimentAttributionInput
): Promise<void> {
  const requestKind = input.capture?.requestKind ?? 'chat_completions';
  const wasTruncated = input.capture?.wasTruncated ?? false;
  const storedPromptHash =
    input.capture && (await putPromptOrNull(input.capture.requestBodyContent));

  try {
    await db.insert(model_experiment_request).values({
      usage_id: input.usageId,
      variant_version_id: input.variantVersionId,
      allocation_subject: input.allocationSubject,
      client_request_id: input.clientRequestId,
      request_kind: requestKind,
      request_body_sha256: storedPromptHash ?? PROMPT_HASH_FAILED,
      was_truncated: wasTruncated,
      created_at: input.createdAt,
    });
  } catch (err) {
    captureException(err, {
      tags: { source: 'model-experiments', operation: 'persistExperimentAttribution' },
      extra: { usageId: input.usageId, variantVersionId: input.variantVersionId },
    });
  }
}
