import * as z from 'zod';
import { ENKRYPT_DETECTOR_IDS, EnkryptPiiEntitySchema } from '@kilocode/db/schema-types';
import type { EnkryptDetectRequestDetectors } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detectors';
import type { EnkryptInputGuardrailConfig } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/settings';

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

/**
 * One Enkrypt scan: of the blocking detectors or the log-only detectors, over the request's tool
 * definitions, its system prompt, its conversation, or the model's response.
 */
export const EnkryptScanReportSchema = z.object({
  scan: z.enum(['blocking', 'log_only']),
  part: z.enum(['tools', 'system', 'conversation', 'response']),
  detectors_enabled: z.array(DetectorIdSchema),
  detectors_blocking: z.array(DetectorIdSchema),
  verdict_cache: z.enum(['off', 'miss', 'hit', 'error']),
  total_characters: z.number(),
  total_segments: z.number(),
  cached_characters: z.number(),
  cached_segments: z.number(),
  /** Attachments, such as images, sent to Enkrypt only as an omission marker. */
  omitted_attachments: z.number(),
  /** Includes the overlap of already-scanned text and omission markers. */
  scanned_characters: z.number(),
  decision: z.enum(['allowed', 'blocked', 'error_fail_closed', 'error_logged', 'client_aborted']),
  error: z.string().nullable(),
  detectors_fired: z.array(DetectorIdSchema),
  /** Enkrypt calls made, including a retry. */
  attempts: z.number(),
  credits_cost: z.number().nullable(),
  latency_ms: z.number(),
});

export type EnkryptScanReport = z.infer<typeof EnkryptScanReportSchema>;

/**
 * What the input guardrail did for one request. Holds settings, counts, and outcomes only, never
 * request text, Enkrypt's messages, or verdict cache keys.
 */
export const EnkryptGuardrailReportSchema = z.object({
  /** Null when the scan could not be prepared, which rejects the request. */
  settings: GuardrailSettingsSchema.nullable(),
  /** The verdict the request acted on; `skip` when no blocking detector gated it. */
  verdict: z.enum(['skip', 'allow', 'block', 'unavailable']),
  unavailable_reason: z.enum(['transient', 'timeout', 'failed']).nullable(),
  /** How long the request waited for the verdict, or null when it never waited. */
  added_latency_ms: z.number().nullable(),
  scans: z.array(
    EnkryptScanReportSchema.extend({
      /** Whether this scan's allow was stored in the verdict cache. */
      verdict_cache_write: z.enum(['written', 'failed', 'skipped']),
    })
  ),
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
  blocking: readonly string[]
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
  config: EnkryptInputGuardrailConfig
): z.infer<typeof GuardrailSettingsSchema> {
  return {
    status: config.status,
    detectors:
      config.status === 'ready' ? detectorSettings(config.detectors, config.blockingDetectors) : [],
  };
}
