import { SecurityAgentConfigSchema, type SecurityAgentConfig } from './types';
import { DEFAULT_SECURITY_NOTIFICATION_POLICY } from '@kilocode/worker-utils/security-notification-policy';

/** Order matters — first entry is the default. */
export const SECURITY_AGENT_MODELS = [
  { id: 'kilo-auto/balanced', name: 'Kilo Balanced', free: false },
  { id: 'anthropic/claude-opus-4.6', name: 'Claude Opus 4.6', free: false },
  { id: 'anthropic/claude-opus-4.5', name: 'Claude Opus 4.5', free: false },
  { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', free: false },
  { id: 'x-ai/grok-code-fast-1', name: 'Grok Code Fast 1 (free)', free: true },
] as const;

export const DEFAULT_SECURITY_AGENT_MODEL = SECURITY_AGENT_MODELS[0].id;
export const DEFAULT_SECURITY_AGENT_TRIAGE_MODEL = SECURITY_AGENT_MODELS[0].id;
export const DEFAULT_SECURITY_AGENT_ANALYSIS_MODEL = SECURITY_AGENT_MODELS[0].id;
export const DEFAULT_SECURITY_AGENT_REMEDIATION_MODEL = SECURITY_AGENT_MODELS[0].id;

export const DEFAULT_SECURITY_AGENT_CONFIG: SecurityAgentConfig = {
  sla_critical_days: 15,
  sla_high_days: 30,
  sla_medium_days: 45,
  sla_low_days: 90,
  auto_sync_enabled: true,
  repository_selection_mode: 'all',
  model_slug: DEFAULT_SECURITY_AGENT_ANALYSIS_MODEL,
  triage_model_slug: DEFAULT_SECURITY_AGENT_TRIAGE_MODEL,
  analysis_model_slug: DEFAULT_SECURITY_AGENT_ANALYSIS_MODEL,
  analysis_mode: 'auto',
  auto_dismiss_enabled: false,
  auto_dismiss_confidence_threshold: 'high',
  auto_analysis_enabled: false,
  auto_analysis_min_severity: 'high',
  auto_analysis_include_existing: false,
  auto_remediation_enabled: false,
  auto_remediation_min_severity: 'high',
  auto_remediation_include_existing: false,
  auto_remediation_enabled_at: null,
  remediation_model_slug: DEFAULT_SECURITY_AGENT_REMEDIATION_MODEL,
  ...DEFAULT_SECURITY_NOTIFICATION_POLICY,
};

export const SECURITY_ANALYSIS_OWNER_CAP = 3;

const SecurityAgentConfigPartialSchema = SecurityAgentConfigSchema.partial().passthrough();

/** Parse a raw (possibly partial) config into a full SecurityAgentConfig. */
export function parseSecurityAgentConfig(rawConfig: unknown): SecurityAgentConfig {
  const partial = SecurityAgentConfigPartialSchema.parse(rawConfig ?? {});
  const parsed = SecurityAgentConfigSchema.parse({
    ...DEFAULT_SECURITY_AGENT_CONFIG,
    ...partial,
  });
  return {
    ...parsed,
    remediation_model_slug:
      partial.remediation_model_slug ??
      parsed.remediation_model_slug ??
      parsed.analysis_model_slug ??
      parsed.model_slug ??
      DEFAULT_SECURITY_AGENT_REMEDIATION_MODEL,
  };
}

export function mergeSecurityAgentConfigPatch(
  storedConfig: Partial<SecurityAgentConfig> | undefined,
  patch: Partial<SecurityAgentConfig>
): SecurityAgentConfig {
  const definedPatch = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined)
  ) as Partial<SecurityAgentConfig>;
  return parseSecurityAgentConfig({ ...storedConfig, ...definedPatch });
}
