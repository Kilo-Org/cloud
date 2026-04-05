import { z } from 'zod';

export const AUTO_ANALYSIS_OWNER_CAP = 2;
export const SECURITY_ANALYSIS_OWNER_CAP = 3;
export const AUTO_ANALYSIS_MAX_ATTEMPTS = 5;

export const SecurityAgentConfigSchema = z
  .object({
    model_slug: z.string().optional(),
    analysis_mode: z.enum(['auto', 'shallow', 'deep']).default('auto'),
    auto_analysis_enabled: z.boolean().default(false),
    auto_analysis_min_severity: z.enum(['critical', 'high', 'medium', 'all']).default('high'),
    auto_analysis_include_existing: z.boolean().default(false),
  })
  .passthrough();

export type SecurityAgentConfig = z.infer<typeof SecurityAgentConfigSchema>;
export type AnalysisMode = SecurityAgentConfig['analysis_mode'];
export type AutoAnalysisMinSeverity = SecurityAgentConfig['auto_analysis_min_severity'];

export const DEFAULT_SECURITY_AGENT_CONFIG: SecurityAgentConfig = {
  model_slug: 'anthropic/claude-opus-4.6',
  analysis_mode: 'auto',
  auto_analysis_enabled: false,
  auto_analysis_min_severity: 'high',
  auto_analysis_include_existing: false,
};

export const AutoAnalysisFailureCodeSchema = z.enum([
  'NETWORK_TIMEOUT',
  'UPSTREAM_5XX',
  'TEMP_TOKEN_FAILURE',
  'START_CALL_AMBIGUOUS',
  'REQUEUE_TEMPORARY_PRECONDITION',
  'ACTOR_RESOLUTION_FAILED',
  'GITHUB_TOKEN_UNAVAILABLE',
  'INVALID_CONFIG',
  'MISSING_OWNERSHIP',
  'PERMISSION_DENIED_PERMANENT',
  'UNSUPPORTED_SEVERITY',
  'INSUFFICIENT_CREDITS',
  'STATE_GUARD_REJECTED',
  'SKIPPED_ALREADY_IN_PROGRESS',
  'SKIPPED_NO_LONGER_ELIGIBLE',
  'REOPEN_LOOP_GUARD',
  'RUN_LOST',
]);

export type AutoAnalysisFailureCode = z.infer<typeof AutoAnalysisFailureCodeSchema>;

export type QueueOwner = { type: 'org'; id: string } | { type: 'user'; id: string };
export type ActorResolutionMode = 'owner' | 'member_fallback';

export const AutoAnalysisOwnerMessageSchema = z.object({
  ownerType: z.enum(['org', 'user']),
  ownerId: z.string().min(1),
  dispatchId: z.string().min(1),
  enqueuedAt: z.string().min(1),
});

export type AutoAnalysisOwnerMessage = z.infer<typeof AutoAnalysisOwnerMessageSchema>;

export type SecurityFindingTriage = {
  needsSandboxAnalysis: boolean;
  needsSandboxReasoning: string;
  suggestedAction: 'dismiss' | 'analyze_codebase' | 'manual_review';
  confidence: 'high' | 'medium' | 'low';
  triageAt: string;
};

export type SecurityFindingAnalysis = {
  triage?: SecurityFindingTriage;
  analyzedAt: string;
  modelUsed?: string;
  triggeredByUserId?: string;
  correlationId?: string;
};

export type ProcessCounters = {
  processed: number;
  launched: number;
  completed: number;
  failed: number;
  requeued: number;
  skipped: number;
};
