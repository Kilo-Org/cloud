/**
 * PostHog tracking utilities for security-agent feature
 *
 * This module provides wide-event style tracking for all security-agent operations.
 * Events are designed to capture comprehensive context for analytics and debugging.
 */

import 'server-only';
import PostHogClient from '@kilocode/web-shared/lib/posthog';
import type { SecurityAgentUiInteraction } from '@/lib/security-agent/core/schemas';
import { captureException } from '@sentry/nextjs';

const posthogClient = PostHogClient();

function captureSecurityAgentEvent(
  event: string,
  distinctId: string,
  properties: Record<string, unknown>,
  sentrySource: string
): void {
  try {
    posthogClient.capture({
      distinctId,
      event,
      properties,
    });
  } catch (error) {
    captureException(error, {
      tags: { source: sentrySource },
      extra: { properties },
    });
  }
}

type BaseSecurityAgentEvent = {
  distinctId: string;
  userId: string;
  organizationId?: string;
};

type SecurityAgentEnabledEvent = BaseSecurityAgentEvent & {
  isEnabled: boolean;
  repositorySelectionMode: string;
  selectedRepoCount: number;
  syncedCount?: number;
  syncErrors?: number;
};

type SecurityAgentConfigSavedEvent = BaseSecurityAgentEvent & {
  autoSyncEnabled?: boolean;
  analysisMode?: string;
  autoDismissEnabled?: boolean;
  autoDismissConfidenceThreshold?: string;
  modelSlug?: string;
  triageModelSlug?: string;
  analysisModelSlug?: string;
  remediationModelSlug?: string;
  autoRemediationEnabled?: boolean;
  autoRemediationMinSeverity?: string;
  autoRemediationIncludeExisting?: boolean;
  slaEnabled?: boolean;
  slaNotificationsEnabled?: boolean;
  slaNotificationMinSeverity?: string;
  slaNotificationWarningDays?: number;
  newFindingNotificationsEnabled?: boolean;
  newFindingNotificationMinSeverity?: string;
  repositorySelectionMode?: string;
  selectedRepoCount?: number;
};

type SecurityAgentSyncEvent = BaseSecurityAgentEvent & {
  syncType: 'single_repo' | 'all_repos';
  repoCount: number;
  synced: number;
  errors: number;
};

type SecurityAgentAnalysisStartedEvent = BaseSecurityAgentEvent & {
  findingId: string;
  model: string;
  triageModel?: string;
  analysisModel?: string;
  analysisMode?: string;
};

type SecurityAgentAnalysisCompletedEvent = BaseSecurityAgentEvent & {
  findingId: string;
  model: string;
  triageModel?: string;
  analysisModel?: string;
  triageOnly: boolean;
  needsSandboxAnalysis?: boolean;
  triageSuggestedAction?: string;
  triageConfidence?: string;
  isExploitable?: boolean | 'unknown';
  durationMs: number;
};

type SecurityAgentFindingDismissedEvent = BaseSecurityAgentEvent & {
  findingId: string;
  reason: string;
  source: string;
  severity: string;
};

type SecurityAgentAutoDismissEvent = BaseSecurityAgentEvent & {
  findingId?: string;
  source: 'triage' | 'sandbox' | 'bulk';
  confidence?: string;
  dismissed?: number;
  skipped?: number;
  errors?: number;
};

type SecurityAgentFullSyncEvent = {
  distinctId: string;
  configsProcessed: number;
  totalSynced: number;
  totalErrors: number;
  durationMs: number;
};

type SecurityAgentUiInteractionEvent = BaseSecurityAgentEvent & {
  interaction: SecurityAgentUiInteraction;
};

type SecurityAgentRemediationActionEvent = BaseSecurityAgentEvent & {
  action: 'start' | 'retry' | 'cancel';
};

export function trackSecurityAgentUiInteraction(properties: SecurityAgentUiInteractionEvent): void {
  const eventProperties = {
    interaction: properties.interaction,
    feature: 'security-agent',
    operation: 'ui_interaction',
    userId: properties.userId,
    ...(properties.organizationId !== undefined
      ? { organizationId: properties.organizationId }
      : {}),
  };

  captureSecurityAgentEvent(
    'security_agent_ui_interaction',
    properties.distinctId,
    eventProperties,
    'posthog_security_agent_ui_interaction'
  );
}

export function trackSecurityAgentRemediationAction(
  properties: SecurityAgentRemediationActionEvent
): void {
  const eventProperties = {
    action: properties.action,
    phase: 'accepted',
    feature: 'security-agent',
    operation: 'remediation_action',
    userId: properties.userId,
    ...(properties.organizationId !== undefined
      ? { organizationId: properties.organizationId }
      : {}),
  };

  captureSecurityAgentEvent(
    'security_agent_remediation_action',
    properties.distinctId,
    eventProperties,
    'posthog_security_agent_remediation_action'
  );
}

/**
 * Track security agent enabled/disabled
 */
export function trackSecurityAgentEnabled(properties: SecurityAgentEnabledEvent): void {
  captureSecurityAgentEvent(
    'security_agent_enabled',
    properties.distinctId,
    {
      ...properties,
      feature: 'security-agent',
      operation: 'set_enabled',
    },
    'posthog_security_agent_enabled'
  );
}

/**
 * Track security agent configuration saved
 */
export function trackSecurityAgentConfigSaved(properties: SecurityAgentConfigSavedEvent): void {
  captureSecurityAgentEvent(
    'security_agent_config_saved',
    properties.distinctId,
    {
      ...properties,
      feature: 'security-agent',
      operation: 'save_config',
    },
    'posthog_security_agent_config_saved'
  );
}

/**
 * Track security agent sync operation
 */
export function trackSecurityAgentSync(properties: SecurityAgentSyncEvent): void {
  captureSecurityAgentEvent(
    'security_agent_sync',
    properties.distinctId,
    {
      ...properties,
      feature: 'security-agent',
      operation: 'sync',
    },
    'posthog_security_agent_sync'
  );
}

/**
 * Track security agent analysis started
 */
export function trackSecurityAgentAnalysisStarted(
  properties: SecurityAgentAnalysisStartedEvent
): void {
  captureSecurityAgentEvent(
    'security_agent_analysis_started',
    properties.distinctId,
    {
      ...properties,
      feature: 'security-agent',
      operation: 'start_analysis',
    },
    'posthog_security_agent_analysis_started'
  );
}

/**
 * Track security agent analysis completed
 */
export function trackSecurityAgentAnalysisCompleted(
  properties: SecurityAgentAnalysisCompletedEvent
): void {
  captureSecurityAgentEvent(
    'security_agent_analysis_completed',
    properties.distinctId,
    {
      ...properties,
      feature: 'security-agent',
      operation: 'analysis_completed',
    },
    'posthog_security_agent_analysis_completed'
  );
}

/**
 * Track security finding manually dismissed
 */
export function trackSecurityAgentFindingDismissed(
  properties: SecurityAgentFindingDismissedEvent
): void {
  captureSecurityAgentEvent(
    'security_agent_finding_dismissed',
    properties.distinctId,
    {
      ...properties,
      feature: 'security-agent',
      operation: 'dismiss_finding',
    },
    'posthog_security_agent_finding_dismissed'
  );
}

/**
 * Track security finding auto-dismissed
 */
export function trackSecurityAgentAutoDismiss(properties: SecurityAgentAutoDismissEvent): void {
  captureSecurityAgentEvent(
    'security_agent_auto_dismiss',
    properties.distinctId,
    {
      ...properties,
      feature: 'security-agent',
      operation: 'auto_dismiss',
    },
    'posthog_security_agent_auto_dismiss'
  );
}

/**
 * Track security agent full sync (cron job)
 */
export function trackSecurityAgentFullSync(properties: SecurityAgentFullSyncEvent): void {
  captureSecurityAgentEvent(
    'security_agent_full_sync',
    properties.distinctId,
    {
      ...properties,
      feature: 'security-agent',
      operation: 'full_sync',
    },
    'posthog_security_agent_full_sync'
  );
}
