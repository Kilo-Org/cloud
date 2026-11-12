import * as z from 'zod';
import {
  ENKRYPT_DETECTOR_IDS,
  EnkryptPiiEntitySchema,
  type EnkryptDetectorId,
} from '@kilocode/db/schema-types';
import type { EnkryptDetectRequestDetectors } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detectors';
import type { EnkryptGuardrailConfig } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/settings';

const DetectorIdSchema = z.enum(ENKRYPT_DETECTOR_IDS);

/**
 * One detector of the organization's configuration. Keywords, topics, and policy text are
 * organization-authored and can name confidential subjects, so only their sizes are reported.
 */
const DetectorSettingsSchema = z.object({
  detector: DetectorIdSchema,
  action: z.enum(['block', 'log']),
  pii_entities: z.array(EnkryptPiiEntitySchema).optional(),
  banned_keyword_count: z.number().optional(),
  topic_count: z.number().optional(),
  policy_format: z.enum(['rules', 'text']).optional(),
  policy_rule_count: z.number().optional(),
});

type DetectorSettings = z.infer<typeof DetectorSettingsSchema>;

const GuardrailSettingsSchema = z.object({
  status: z.enum(['ready', 'invalid']),
  detectors: z.array(DetectorSettingsSchema),
});

const ScanDecisionSchema = z.enum([
  'allowed',
  'blocked',
  'error_fail_closed',
  'error_logged',
  'client_aborted',
]);

const VerdictCacheSchema = z.enum(['off', 'miss', 'hit', 'error']);

/** Fields shared by a single scan and the aggregate of a request's tool definition scans. */
const scanOutcomeShape = {
  scan: z.enum(['blocking', 'log_only']),
  detectors_enabled: z.array(DetectorIdSchema),
  detectors_blocking: z.array(DetectorIdSchema),
  verdict_cache: VerdictCacheSchema,
  total_characters: z.number(),
  cached_characters: z.number(),
  /**
   * Includes the separators between packed segments and the headers of split segments, so it can
   * exceed `total_characters`.
   */
  scanned_characters: z.number(),
  decision: ScanDecisionSchema,
  error: z.string().nullable(),
  detectors_fired: z.array(DetectorIdSchema),
  /** Enkrypt calls made, including retries. */
  attempts: z.number(),
  credits_cost: z.number().nullable(),
  /** Includes time spent waiting for a free call slot. */
  latency_ms: z.number(),
};

/**
 * One Enkrypt scan: of the blocking detectors or the log-only detectors, over one of the request's
 * tool definitions, its system prompt, its conversation, or the model's response, or one chunk of
 * them.
 */
export const EnkryptScanReportSchema = z.object({
  ...scanOutcomeShape,
  part: z.enum(['tools', 'system', 'conversation', 'response']),
  total_segments: z.number(),
  cached_segments: z.number(),
  /** Attachments, such as images, sent to Enkrypt only as an omission marker. */
  omitted_attachments: z.number(),
});

export type EnkryptScanReport = z.infer<typeof EnkryptScanReportSchema>;

/** At most this many flagged tools are listed; `tools_flagged` counts them all. */
export const MAX_REPORTED_FLAGGED_TOOLS = 20;

/** A tool definition or response format whose scan fired a detector or failed. */
const FlaggedToolSchema = z.object({
  kind: z.enum(['tool', 'response_format']),
  name: z.string().nullable(),
  detectors_fired: z.array(DetectorIdSchema),
  error: z.string().nullable(),
});

export type EnkryptFlaggedTool = z.infer<typeof FlaggedToolSchema>;

/**
 * The scans of a request's tool definitions and response formats by the blocking or the log-only
 * detectors, aggregated: each segment of each is cached on its own, and each tool with uncached
 * segments is scanned by its own calls. `verdict_cache` is `hit` when the cache covered at least
 * one segment. The decision and error are those of the most severe tool. Characters, calls, and
 * credits are summed; the latency runs until the last tool's scan finished.
 */
export const EnkryptToolScanReportSchema = z.object({
  ...scanOutcomeShape,
  part: z.literal('tools'),
  tools_total: z.number(),
  /**
   * Decided by the cache, with the same organization and detectors: every segment allowed before,
   * or any segment blocked before. Not scanned again.
   */
  tools_cached: z.number(),
  /** With segments the cache did not cover, which were scanned by the tool's own calls, or failed. */
  tools_scanned: z.number(),
  tools_flagged: z.number(),
  /** The tools that fired a detector or failed, most severe first, by name only. */
  flagged_tools: z.array(FlaggedToolSchema),
});

export type EnkryptToolScanReport = z.infer<typeof EnkryptToolScanReportSchema>;

const VerdictCacheWriteSchema = z.enum(['written', 'failed', 'skipped']);

/** The verdict cache write of a scan: for tool definitions, `failed` if any write failed, else `written` if any was written. */
const verdictCacheWriteShape = { verdict_cache_write: VerdictCacheWriteSchema };

/**
 * The scan of a request's system prompt or conversation by the blocking or the log-only detectors.
 * Each segment has its verdict cached on its own; `cached_segments` counts those the cache covered
 * whole. The uncached ones are packed into chunks of at most one Enkrypt call each. The decision is
 * that of the most severe chunk, and the error that of the most severe chunk that failed.
 * Characters, calls, and credits are summed; the latency runs until the last chunk's scan finished.
 */
const EnkryptSegmentsScanReportSchema = EnkryptScanReportSchema.extend({
  part: z.enum(['system', 'conversation']),
  /** Chunks the uncached segments were packed into, so 0 when the cache covered all of them. */
  chunks: z.number(),
});

/** A scan of the input guardrail: the aggregate of the tool definitions, the system prompt, or the conversation. */
export const EnkryptInputScanReportSchema = z.union([
  EnkryptToolScanReportSchema.extend(verdictCacheWriteShape),
  EnkryptSegmentsScanReportSchema.extend(verdictCacheWriteShape),
]);

export type EnkryptInputScanReport = z.infer<typeof EnkryptInputScanReportSchema>;

export type EnkryptSegmentsScanReport = z.infer<typeof EnkryptSegmentsScanReportSchema>;

/** An input guardrail scan before its verdict cache write is known. */
export type EnkryptInputPartScanReport = EnkryptToolScanReport | EnkryptSegmentsScanReport;

/**
 * What the input guardrail did for one request. Holds settings, counts, outcomes, and the names of
 * flagged tools only, never other request text, Enkrypt's messages, or verdict cache keys.
 */
export const EnkryptGuardrailReportSchema = z.object({
  /** Null when the scan could not be prepared, which rejects the request. */
  settings: GuardrailSettingsSchema.nullable(),
  /** The verdict the request acted on; `skip` when no blocking detector gated it. */
  verdict: z.enum(['skip', 'allow', 'block', 'unavailable']),
  unavailable_reason: z.enum(['transient', 'timeout', 'failed']).nullable(),
  /** How long the request waited for the verdict, or null when it never waited. */
  added_latency_ms: z.number().nullable(),
  scans: z.array(EnkryptInputScanReportSchema),
});

export type EnkryptGuardrailReport = z.infer<typeof EnkryptGuardrailReportSchema>;

/**
 * What the output guardrail did for one response. Holds settings, sizes, timings, and outcomes
 * only, never response text or Enkrypt's messages. Output scans never use the verdict cache.
 */
export const EnkryptOutputGuardrailReportSchema = z.object({
  settings: GuardrailSettingsSchema,
  /** Whether a blocking detector held the response back until it was scanned. */
  held_back: z.boolean(),
  /** Upstream response bytes read before the decision, or null when not held back. */
  held_bytes: z.number().nullable(),
  /** From the guardrail's first read until the upstream response ended, so mostly generation. */
  held_ms: z.number().nullable(),
  upstream_read_failed: z.boolean(),
  /** Length of the scanned response text, or null when the response was not read. */
  output_characters: z.number().nullable(),
  /** Why Enkrypt was not asked. A blocking guardrail then withholds the response. */
  not_scanned_reason: z
    .enum(['invalid_config', 'output_too_large', 'held_output_too_large'])
    .nullable(),
  /** The verdict the response acted on; `skip` when no blocking detector gated it. */
  verdict: z.enum(['skip', 'allow', 'block', 'unavailable']),
  unavailable_reason: z.enum(['transient', 'timeout', 'failed']).nullable(),
  /** How long the held-back response waited for the verdict after the upstream response ended. */
  added_latency_ms: z.number().nullable(),
  scans: z.array(EnkryptScanReportSchema),
});

export type EnkryptOutputGuardrailReport = z.infer<typeof EnkryptOutputGuardrailReportSchema>;

function detectorSettings(
  detectors: EnkryptDetectRequestDetectors,
  blocking: readonly EnkryptDetectorId[]
): DetectorSettings[] {
  return ENKRYPT_DETECTOR_IDS.flatMap((detector): DetectorSettings[] => {
    if (!detectors[detector]) return [];
    const base = { detector, action: blocking.includes(detector) ? 'block' : 'log' } as const;
    const { pii, keyword_detector, topic_detector, policy_violation } = detectors;
    switch (detector) {
      case 'pii':
        return [{ ...base, pii_entities: pii?.entities ?? [] }];
      case 'keyword_detector':
        return [{ ...base, banned_keyword_count: keyword_detector?.banned_keywords.length ?? 0 }];
      case 'topic_detector':
        return [{ ...base, topic_count: topic_detector?.topic.length ?? 0 }];
      case 'policy_violation':
        return [
          policy_violation && 'rules' in policy_violation
            ? { ...base, policy_format: 'rules', policy_rule_count: policy_violation.rules.length }
            : { ...base, policy_format: 'text' },
        ];
      default:
        return [base];
    }
  });
}

export function guardrailSettings(
  config: EnkryptGuardrailConfig
): z.infer<typeof GuardrailSettingsSchema> {
  return {
    status: config.status,
    detectors:
      config.status === 'ready' ? detectorSettings(config.detectors, config.blockingDetectors) : [],
  };
}
