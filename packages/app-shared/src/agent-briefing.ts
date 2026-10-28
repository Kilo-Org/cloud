import { z } from 'zod';

export const BRIEFING_MAX_SESSIONS = 32;
export const BRIEFING_MAX_SOURCES = 256;
export const BRIEFING_MAX_SOURCES_PER_SESSION = 32;
export const BRIEFING_MAX_TITLE_LENGTH = 160;
export const BRIEFING_MAX_URL_LENGTH = 2048;
export const BRIEFING_MAX_EXCERPT_BYTES = 1024;
export const BRIEFING_MAX_SNAPSHOT_BYTES = 48 * 1024;

export const briefingContextSchema = z.object({
  id: z.string(),
  organizationId: z.string().nullable(),
  name: z.string(),
});
export const briefingSourceSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  kind: z.enum(['activity', 'pull_request', 'blocker', 'artifact']),
  title: z.string().max(BRIEFING_MAX_TITLE_LENGTH),
  url: z.string().max(BRIEFING_MAX_URL_LENGTH),
  occurredAt: z.string().datetime(),
  excerpt: z
    .string()
    .refine(
      value => briefingUtf8End(value, BRIEFING_MAX_EXCERPT_BYTES) === value.length,
      'Excerpt exceeds UTF-8 byte limit'
    )
    .optional(),
});
export const briefingSummaryErrorSchema = z.enum([
  'model_pricing_unavailable',
  'invalid_model_pricing',
  'input_too_large',
  'spend_limit_too_low',
  'model_not_allowed',
  'balance_unavailable',
  'permission_unavailable',
  'gateway_declined',
  'invalid_summary',
  'time_limit',
  'generation_failed',
]);
export const briefingSummarySchema = z.object({
  status: z.enum(['disabled', 'pending', 'running', 'ready', 'failed', 'unavailable']),
  text: z.string().nullable(),
  model: z.string().nullable(),
  costMicrodollars: z.number(),
  chargeStatus: z.enum(['pending', 'settled']),
  estimatedCostMicrodollars: z.number().nullable(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  error: briefingSummaryErrorSchema.nullable(),
});
export const briefingScorecardSchema = z.object({
  sessions: z.number(),
  pullRequests: z.number(),
  blockers: z.number(),
});
export const briefingCoverageSchema = z.object({
  activity: z.literal('partial'),
  blockers: z.literal('partial'),
  pullRequests: z.literal('partial'),
});
export const briefingReportSchema = z.object({
  id: z.string(),
  createdAt: z.string().datetime(),
  capturedAt: z.string().datetime(),
  truncated: z.boolean(),
  timezone: z.string(),
  context: briefingContextSchema,
  localDate: z.string(),
  nightStartAt: z.string().datetime(),
  cutoffAt: z.string().datetime(),
  morningEndAt: z.string().datetime(),
  publishedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
  readAt: z.string().datetime().nullable(),
  dismissedAt: z.string().datetime().nullable(),
  scorecard: briefingScorecardSchema,
  coverage: briefingCoverageSchema,
  sessions: z
    .array(
      z.object({
        sessionId: z.string(),
        title: z.string().max(BRIEFING_MAX_TITLE_LENGTH),
        url: z.string().max(BRIEFING_MAX_URL_LENGTH),
        status: z.string().nullable(),
        sources: z.array(briefingSourceSchema).max(BRIEFING_MAX_SOURCES_PER_SESSION),
      })
    )
    .max(BRIEFING_MAX_SESSIONS),
  sources: z.array(briefingSourceSchema).max(BRIEFING_MAX_SOURCES),
  summary: briefingSummarySchema,
  expiresAt: z.string().datetime(),
});
export const briefingEstimateSchema = z.object({
  model: z.string(),
  estimatedCostMicrodollars: z.number(),
  maximumCostMicrodollars: z.number(),
  maxDurationSeconds: z.number(),
  estimateToken: z.string(),
  canGenerate: z.boolean(),
  unavailableReason: briefingSummaryErrorSchema.nullable(),
});
export const briefingContextPreferencesSchema = z.object({
  context: briefingContextSchema,
  enabled: z.boolean(),
  model: z.string(),
  maxDurationSeconds: z.number().int(),
  maxSpendMicrodollars: z.number().int(),
});
export const briefingPreferencesSchema = z.object({
  timezone: z.string(),
  nightStart: z.string(),
  morningStart: z.string(),
  morningEnd: z.string(),
  language: z.string(),
  notificationsEnabled: z.boolean(),
  defaultModel: z.string(),
  contexts: z.array(briefingContextPreferencesSchema),
});
export type BriefingContext = z.infer<typeof briefingContextSchema>;
export type BriefingSource = z.infer<typeof briefingSourceSchema>;
export type BriefingSummary = z.infer<typeof briefingSummarySchema>;
export type BriefingScorecard = z.infer<typeof briefingScorecardSchema>;
export type BriefingCoverage = z.infer<typeof briefingCoverageSchema>;
export type BriefingReport = z.infer<typeof briefingReportSchema>;
export type BriefingEstimate = z.infer<typeof briefingEstimateSchema>;
export type BriefingPreferences = z.infer<typeof briefingPreferencesSchema>;
export type BriefingContextPreferences = z.infer<typeof briefingContextPreferencesSchema>;
export const DEFAULT_BRIEFING_SCHEDULE = {
  nightStart: '22:00',
  morningStart: '08:00',
  morningEnd: '12:00',
} as const;
export const DEFAULT_BRIEFING_MAX_DURATION_SECONDS = 600;
export const DEFAULT_BRIEFING_MAX_SPEND_MICRODOLLARS = 2_000_000;
export function briefingHasActivity(scorecard: BriefingScorecard): boolean {
  return scorecard.sessions > 0;
}
export function isBriefingVisible(report: BriefingReport, now = Date.now()): boolean {
  return (
    report.publishedAt !== null &&
    report.dismissedAt === null &&
    Date.parse(report.publishedAt) <= now &&
    Date.parse(report.expiresAt) > now &&
    briefingHasActivity(report.scorecard)
  );
}
export function redactBriefingExcerpt(
  value: string,
  maxBytes = BRIEFING_MAX_EXCERPT_BYTES
): string {
  const redacted = value
    .replace(
      /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g,
      '[redacted key]'
    )
    .replace(
      /(?:bearer\s+|(?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,;"}]+/gi,
      '[redacted credential]'
    )
    .replace(/\b(?:sk-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]+/g, '[redacted token]')
    .replace(/\b[A-Za-z0-9_-]{48,}\b/g, '[redacted value]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[redacted email]')
    .replace(/(https?:\/\/[^\s?]+)\?[^\s]+/g, '$1');
  return truncateBriefingUtf8(redacted, maxBytes);
}

export function truncateBriefingUtf8(value: string, maxBytes: number): string {
  const end = briefingUtf8End(value, maxBytes);
  return end === value.length ? value : value.slice(0, end);
}

function briefingUtf8End(value: string, maxBytes: number): number {
  let bytes = 0;
  let end = 0;
  while (end < value.length) {
    const code = value.charCodeAt(end);
    const next = value.charCodeAt(end + 1);
    const pair = code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
    const width = pair ? 4 : code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
    if (bytes + width > maxBytes) break;
    bytes += width;
    end += pair ? 2 : 1;
  }
  return end;
}
