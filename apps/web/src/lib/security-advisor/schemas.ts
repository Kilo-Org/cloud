import * as z from 'zod';

// --- Request schemas ---

/** Where the request originates from */
export const SourcePlatform = z.enum([
  'openclaw', // Self-hosted OpenClaw instance (plugin installed manually)
  'kiloclaw', // KiloClaw managed instance (plugin pre-installed)
]);
export type SourcePlatform = z.infer<typeof SourcePlatform>;

/** How the request was triggered */
export const SourceMethod = z.enum([
  'plugin', // @kiloclaw/security-advisor plugin
  'api', // Direct API call (curl, integration, etc.)
  'webhook', // Inbound webhook trigger
  'cloud-agent', // Cloud agent session
]);
export type SourceMethod = z.infer<typeof SourceMethod>;

export const FindingSeverity = z.enum(['critical', 'warn', 'info']);
export type FindingSeverity = z.infer<typeof FindingSeverity>;

export const AuditFinding = z.object({
  checkId: z.string(),
  severity: FindingSeverity,
  title: z.string(),
  detail: z.string(),
  remediation: z.string().nullable(),
});
export type AuditFinding = z.infer<typeof AuditFinding>;

export const SecurityAdvisorRequestSchema = z.object({
  apiVersion: z.literal('2026-04-01'),

  source: z.object({
    platform: SourcePlatform,
    method: SourceMethod,
    pluginVersion: z.string().optional(),
    openclawVersion: z.string().optional(),
  }),

  audit: z.object({
    ts: z.number(),
    summary: z.object({
      critical: z.number(),
      warn: z.number(),
      info: z.number(),
    }),
    findings: z.array(AuditFinding),
    deep: z.record(z.string(), z.unknown()).optional(),
    secretDiagnostics: z.array(z.unknown()).optional(),
  }),

  publicIp: z
    .string()
    .regex(/^(?:\d{1,3}\.){3}\d{1,3}$|^[0-9a-fA-F:]+$/, 'Must be a valid IPv4 or IPv6 address')
    .optional(),
});
export type SecurityAdvisorRequest = z.infer<typeof SecurityAdvisorRequestSchema>;

// --- Response schemas ---

export const RecommendationPriority = z.enum(['immediate', 'high', 'medium', 'low']);
export type RecommendationPriority = z.infer<typeof RecommendationPriority>;

export const ReportFinding = z.object({
  checkId: z.string(),
  severity: FindingSeverity,
  title: z.string(),
  explanation: z.string(),
  risk: z.string(),
  fix: z.string().nullable(),
  kiloClawComparison: z.string().nullable(),
});
export type ReportFinding = z.infer<typeof ReportFinding>;

export const Recommendation = z.object({
  priority: RecommendationPriority,
  action: z.string(),
});
export type Recommendation = z.infer<typeof Recommendation>;

export const SecurityAdvisorResponseSchema = z.object({
  apiVersion: z.literal('2026-04-01'),
  status: z.literal('success'),
  report: z.object({
    markdown: z.string(),
    summary: z.object({
      critical: z.number(),
      warn: z.number(),
      info: z.number(),
      passed: z.number(),
    }),
    findings: z.array(ReportFinding),
    recommendations: z.array(Recommendation),
  }),
});
export type SecurityAdvisorResponse = z.infer<typeof SecurityAdvisorResponseSchema>;

// --- Error schema ---

export const SecurityAdvisorErrorCode = z.enum([
  'unauthorized',
  'rate_limited',
  'invalid_payload',
  'invalid_api_version',
  'internal_error',
]);
export type SecurityAdvisorErrorCode = z.infer<typeof SecurityAdvisorErrorCode>;

export const SecurityAdvisorErrorSchema = z.object({
  apiVersion: z.literal('2026-04-01'),
  status: z.literal('error'),
  error: z.object({
    code: SecurityAdvisorErrorCode,
    message: z.string(),
    retryAfter: z.number().optional(),
  }),
});
export type SecurityAdvisorError = z.infer<typeof SecurityAdvisorErrorSchema>;

// --- Comparison schema ---

export const KiloClawComparisonEntry = z.object({
  area: z.string(),
  summary: z.string(),
  detail: z.string(),
  matchCheckIds: z.array(z.string()),
});
export type KiloClawComparisonEntry = z.infer<typeof KiloClawComparisonEntry>;

// --- Constants ---

export const API_VERSION = '2026-04-01' as const;
export const RATE_LIMIT_PER_DAY = 5;
