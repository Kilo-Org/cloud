import type { Repository } from '@/components/code-reviews/RepositoryMultiSelect';
import {
  DEFAULT_SECURITY_AGENT_ANALYSIS_MODEL,
  DEFAULT_SECURITY_AGENT_REMEDIATION_MODEL,
  DEFAULT_SECURITY_AGENT_TRIAGE_MODEL,
} from '@/lib/security-agent/core/constants';
import type { DependabotAlertsAvailability } from '@/lib/security-agent/core/types';

export type SlaConfig = {
  critical: number;
  high: number;
  medium: number;
  low: number;
};

export type AnalysisMode = 'auto' | 'shallow' | 'deep';
export type AutoDismissConfidenceThreshold = 'high' | 'medium' | 'low';
export type AutoAnalysisMinSeverity = 'critical' | 'high' | 'medium' | 'all';
export type AutoRemediationMinSeverity = 'critical' | 'high' | 'medium' | 'all';
export type NotificationMinSeverity = 'critical' | 'high' | 'medium' | 'low';
export type RepositorySelectionMode = 'all' | 'selected';

export type SecurityRepository = {
  id: number;
  fullName: string;
  name: string;
  private: boolean;
  dependabotAlerts: DependabotAlertsAvailability;
};

export type SecurityConfigFormState = {
  slaConfig: SlaConfig;
  slaEnabled: boolean;
  repositorySelectionMode: RepositorySelectionMode;
  selectedRepositoryIds: number[];
  triageModelSlug: string;
  analysisModelSlug: string;
  analysisMode: AnalysisMode;
  autoDismissEnabled: boolean;
  autoDismissConfidenceThreshold: AutoDismissConfidenceThreshold;
  autoAnalysisEnabled: boolean;
  autoAnalysisMinSeverity: AutoAnalysisMinSeverity;
  autoAnalysisIncludeExisting: boolean;
  autoRemediationEnabled: boolean;
  autoRemediationMinSeverity: AutoRemediationMinSeverity;
  autoRemediationIncludeExisting: boolean;
  autoRemediationRequireApproval: boolean;
  remediationModelSlug: string;
  slaNotificationsEnabled: boolean;
  slaNotificationMinSeverity: NotificationMinSeverity;
  slaNotificationWarningDays: number;
  newFindingNotificationsEnabled: boolean;
  newFindingNotificationMinSeverity: NotificationMinSeverity;
};

export type SecurityConfigSavePayload = SlaConfig &
  Omit<SecurityConfigFormState, 'slaConfig'> & {
    modelSlug?: string;
  };

/** The server-side config shape consumed when hydrating the settings form. */
export type SecurityConfigFormSource = {
  slaCriticalDays?: number;
  slaHighDays?: number;
  slaMediumDays?: number;
  slaLowDays?: number;
  slaEnabled?: boolean;
  repositorySelectionMode?: RepositorySelectionMode;
  selectedRepositoryIds?: number[];
  triageModelSlug?: string;
  analysisModelSlug?: string;
  modelSlug?: string;
  analysisMode?: AnalysisMode;
  autoDismissEnabled?: boolean;
  autoDismissConfidenceThreshold?: AutoDismissConfidenceThreshold;
  autoAnalysisEnabled?: boolean;
  autoAnalysisMinSeverity?: AutoAnalysisMinSeverity;
  autoAnalysisIncludeExisting?: boolean;
  autoRemediationEnabled?: boolean;
  autoRemediationMinSeverity?: AutoRemediationMinSeverity;
  autoRemediationIncludeExisting?: boolean;
  autoRemediationRequireApproval?: boolean;
  remediationModelSlug?: string;
  slaNotificationsEnabled?: boolean;
  slaNotificationMinSeverity?: NotificationMinSeverity;
  slaNotificationWarningDays?: number;
  newFindingNotificationsEnabled?: boolean;
  newFindingNotificationMinSeverity?: NotificationMinSeverity;
};

export function buildSecurityConfigFormState(
  configData: SecurityConfigFormSource | undefined
): SecurityConfigFormState {
  return {
    slaConfig: {
      critical: configData?.slaCriticalDays ?? 15,
      high: configData?.slaHighDays ?? 30,
      medium: configData?.slaMediumDays ?? 45,
      low: configData?.slaLowDays ?? 90,
    },
    slaEnabled: configData?.slaEnabled ?? true,
    repositorySelectionMode: configData?.repositorySelectionMode ?? 'selected',
    selectedRepositoryIds: configData?.selectedRepositoryIds ?? [],
    triageModelSlug:
      configData?.triageModelSlug ?? configData?.modelSlug ?? DEFAULT_SECURITY_AGENT_TRIAGE_MODEL,
    analysisModelSlug:
      configData?.analysisModelSlug ??
      configData?.modelSlug ??
      DEFAULT_SECURITY_AGENT_ANALYSIS_MODEL,
    analysisMode: configData?.analysisMode ?? 'auto',
    autoDismissEnabled: configData?.autoDismissEnabled ?? false,
    autoDismissConfidenceThreshold: configData?.autoDismissConfidenceThreshold ?? 'high',
    autoAnalysisEnabled: configData?.autoAnalysisEnabled ?? false,
    autoAnalysisMinSeverity: configData?.autoAnalysisMinSeverity ?? 'high',
    autoAnalysisIncludeExisting: configData?.autoAnalysisIncludeExisting ?? false,
    autoRemediationEnabled: configData?.autoRemediationEnabled ?? false,
    autoRemediationMinSeverity: configData?.autoRemediationMinSeverity ?? 'high',
    autoRemediationIncludeExisting: configData?.autoRemediationIncludeExisting ?? false,
    autoRemediationRequireApproval: configData?.autoRemediationRequireApproval ?? true,
    remediationModelSlug:
      configData?.remediationModelSlug ??
      configData?.analysisModelSlug ??
      configData?.modelSlug ??
      DEFAULT_SECURITY_AGENT_REMEDIATION_MODEL,
    slaNotificationsEnabled: configData?.slaNotificationsEnabled ?? false,
    slaNotificationMinSeverity: configData?.slaNotificationMinSeverity ?? 'high',
    slaNotificationWarningDays: configData?.slaNotificationWarningDays ?? 3,
    newFindingNotificationsEnabled: configData?.newFindingNotificationsEnabled ?? false,
    newFindingNotificationMinSeverity: configData?.newFindingNotificationMinSeverity ?? 'high',
  };
}

export function buildSecurityConfigSavePayload(
  state: SecurityConfigFormState
): SecurityConfigSavePayload {
  return {
    ...state.slaConfig,
    slaEnabled: state.slaEnabled,
    repositorySelectionMode: state.repositorySelectionMode,
    selectedRepositoryIds: state.selectedRepositoryIds,
    triageModelSlug: state.triageModelSlug,
    analysisModelSlug: state.analysisModelSlug,
    modelSlug: state.analysisModelSlug,
    analysisMode: state.analysisMode,
    autoDismissEnabled: state.autoDismissEnabled,
    autoDismissConfidenceThreshold: state.autoDismissConfidenceThreshold,
    autoAnalysisEnabled: state.autoAnalysisEnabled,
    autoAnalysisMinSeverity: state.autoAnalysisMinSeverity,
    autoAnalysisIncludeExisting: state.autoAnalysisIncludeExisting,
    autoRemediationEnabled: state.autoRemediationEnabled,
    autoRemediationMinSeverity: state.autoRemediationMinSeverity,
    autoRemediationIncludeExisting: state.autoRemediationIncludeExisting,
    autoRemediationRequireApproval: state.autoRemediationRequireApproval,
    remediationModelSlug: state.remediationModelSlug,
    slaNotificationsEnabled: state.slaNotificationsEnabled,
    slaNotificationMinSeverity: state.slaNotificationMinSeverity,
    slaNotificationWarningDays: state.slaNotificationWarningDays,
    newFindingNotificationsEnabled: state.newFindingNotificationsEnabled,
    newFindingNotificationMinSeverity: state.newFindingNotificationMinSeverity,
  };
}

export function toRepositoryOptions(repositories: SecurityRepository[]): Repository[] {
  return repositories.map(repository => ({
    id: repository.id,
    name: repository.name,
    full_name: repository.fullName,
    private: repository.private,
  }));
}
