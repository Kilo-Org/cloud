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
  'plugin', // @kilocode/shell-security plugin
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
  remediation: z.string().nullable().optional(),
});
export type AuditFinding = z.infer<typeof AuditFinding>;

/**
 * Semver regex (major.minor.patch with optional prerelease + build metadata).
 * Matches the format used by `@kilocode/cli` and other kilocode packages.
 *
 * `source.pluginVersion` is optional at the field level because non-plugin
 * callers (`method: 'api' | 'webhook' | 'cloud-agent'`) have no plugin
 * involved and shouldn't be forced to invent a version string. When the
 * caller IS a plugin (`method: 'plugin'`), we enforce presence + semver
 * format via the superRefine below, giving us a clean foundation for
 * observability and future version-based branching without breaking any
 * non-plugin integration path.
 */
const SEMVER_REGEX = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;
const SemverString = z
  .string()
  .regex(SEMVER_REGEX, 'Must be a semver version string (e.g. "1.2.3")');

export const ShellSecurityRequestSchema = z
  .object({
    apiVersion: z.literal('2026-04-01'),

    source: z.object({
      platform: SourcePlatform,
      method: SourceMethod,
      // Plugin package semver. Optional here so non-plugin callers aren't
      // forced to send a version; superRefine below requires it (and
      // enforces semver format) whenever method === 'plugin'. Server logs
      // and persists this to `security_advisor_scans.plugin_version` on
      // every scan; future schema evolutions may branch on it.
      pluginVersion: SemverString.optional(),
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
  })
  .superRefine((data, ctx) => {
    // Plugin callers must always announce their version. SemverString
    // already validates format when pluginVersion is present; here we
    // guard presence for the plugin-method path specifically.
    if (data.source.method === 'plugin' && !data.source.pluginVersion) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['source', 'pluginVersion'],
        message: 'source.pluginVersion is required when source.method is "plugin"',
      });
    }
  });
export type ShellSecurityRequest = z.infer<typeof ShellSecurityRequestSchema>;

// --- Response schemas ---

export const RecommendationPriority = z.enum(['immediate', 'high', 'medium', 'low']);
export type RecommendationPriority = z.infer<typeof RecommendationPriority>;

/** Overall letter grade for the audit, derived from finding counts + severities. */
export const ReportGrade = z.enum(['A', 'B', 'C', 'D', 'F']);
export type ReportGrade = z.infer<typeof ReportGrade>;

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

export const ShellSecurityResponseSchema = z.object({
  apiVersion: z.literal('2026-04-01'),
  status: z.literal('success'),
  report: z.object({
    markdown: z.string(),
    grade: ReportGrade,
    score: z.number().int().min(0).max(100),
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
export type ShellSecurityResponse = z.infer<typeof ShellSecurityResponseSchema>;

// --- Error schema ---

export const ShellSecurityErrorCode = z.enum([
  'unauthorized',
  'rate_limited',
  'invalid_payload',
  'invalid_api_version',
  'internal_error',
]);
export type ShellSecurityErrorCode = z.infer<typeof ShellSecurityErrorCode>;

export const ShellSecurityErrorSchema = z.object({
  apiVersion: z.literal('2026-04-01'),
  status: z.literal('error'),
  error: z.object({
    code: ShellSecurityErrorCode,
    message: z.string(),
    retryAfter: z.number().optional(),
  }),
});
export type ShellSecurityError = z.infer<typeof ShellSecurityErrorSchema>;

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
export const RATE_LIMIT_PER_DAY = 50;
