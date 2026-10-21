import { z } from 'zod';

export const briefingContextSchema = z.object({
  id: z.string(),
  organizationId: z.string().nullable(),
  name: z.string(),
});
export const briefingSourceSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  kind: z.enum(['activity', 'pull_request', 'blocker', 'cost', 'artifact']),
  title: z.string(),
  url: z.string(),
  occurredAt: z.string().datetime(),
  excerpt: z.string().max(600).optional(),
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
  status: z.enum(['disabled', 'pending', 'running', 'ready', 'failed', 'unavailable', 'outdated']),
  text: z.string().nullable(),
  model: z.string().nullable(),
  costMicrodollars: z.number(),
  chargeStatus: z.enum(['pending', 'settled']),
  estimatedCostMicrodollars: z.number().nullable(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  error: briefingSummaryErrorSchema.nullable(),
  canRetry: z.boolean(),
});
export const briefingScorecardSchema = z.object({
  sessions: z.number(),
  pullRequests: z.number(),
  blockers: z.number(),
  spendMicrodollars: z.number(),
});
export const briefingCoverageSchema = z.object({
  activity: z.enum(['complete', 'partial']),
  spend: z.enum(['complete', 'partial', 'unavailable']),
  blockers: z.enum(['complete', 'partial']),
  pullRequests: z.enum(['complete', 'partial']),
});
export const briefingReportSchema = z.object({
  id: z.string(),
  context: briefingContextSchema,
  localDate: z.string(),
  nightStartAt: z.string().datetime(),
  cutoffAt: z.string().datetime(),
  morningEndAt: z.string().datetime(),
  publishedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
  revision: z.number().int(),
  revised: z.boolean(),
  readAt: z.string().datetime().nullable(),
  dismissedAt: z.string().datetime().nullable(),
  scorecard: briefingScorecardSchema,
  coverage: briefingCoverageSchema,
  sessions: z.array(
    z.object({
      sessionId: z.string(),
      title: z.string(),
      url: z.string(),
      status: z.string().nullable(),
      spendMicrodollars: z.number(),
      sources: z.array(briefingSourceSchema),
    })
  ),
  sources: z.array(briefingSourceSchema),
  summary: briefingSummarySchema,
  expiresAt: z.string().datetime(),
});
export const briefingContextPreferencesSchema = z.object({
  context: briefingContextSchema,
  aiEnabled: z.boolean(),
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
export type BriefingPreferences = z.infer<typeof briefingPreferencesSchema>;
export type BriefingContextPreferences = z.infer<typeof briefingContextPreferencesSchema>;
export const DEFAULT_BRIEFING_SCHEDULE = {
  nightStart: '22:00',
  morningStart: '08:00',
  morningEnd: '12:00',
} as const;
export const DEFAULT_BRIEFING_MAX_DURATION_SECONDS = 600;
export const DEFAULT_BRIEFING_MAX_SPEND_MICRODOLLARS = 2_000_000;
export function isBriefingVisible(report: BriefingReport, now = Date.now()): boolean {
  return (
    report.publishedAt !== null &&
    report.dismissedAt === null &&
    Date.parse(report.publishedAt) <= now &&
    Date.parse(report.expiresAt) > now &&
    report.scorecard.sessions > 0
  );
}
export function redactBriefingExcerpt(value: string, maxLength = 600): string {
  return value
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
    .replace(/(https?:\/\/[^\s?]+)\?[^\s]+/g, '$1')
    .slice(0, maxLength);
}
