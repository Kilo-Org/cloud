/**
 * PostHog tracking utilities for security-agent feature
 *
 * This module provides wide-event style tracking for all security-agent operations.
 * Events are designed to capture comprehensive context for analytics and debugging.
 */

import 'server-only';
import PostHogClient from '@/lib/posthog';
import { captureException } from '@sentry/nextjs';

const posthogClient = PostHogClient();

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
  autoDismissEnabled?: boolean;
  autoDismissConfidenceThreshold?: string;
  modelSlug?: string;
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
  forceSandbox: boolean;
};

type SecurityAgentAnalysisCompletedEvent = BaseSecurityAgentEvent & {
  findingId: string;
  model: string;
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

/**
 * Track security agent enabled/disabled
 */
export function trackSecurityAgentEnabled(properties: SecurityAgentEnabledEvent): void {
  try {
    posthogClient.capture({
      distinctId: properties.distinctId,
      event: 'security_agent_enabled',
      properties: {
        ...properties,
        feature: 'security-agent',
        operation: 'set_enabled',
      },
    });
  } catch (error) {
    captureException(error, {
      tags: { source: 'posthog_security_agent_enabled' },
      extra: { properties },
    });
  }
}

/**
 * Track security agent configuration saved
 */
export function trackSecurityAgentConfigSaved(properties: SecurityAgentConfigSavedEvent): void {
  try {
    posthogClient.capture({
      distinctId: properties.distinctId,
      event: 'security_agent_config_saved',
      properties: {
        ...properties,
        feature: 'security-agent',
        operation: 'save_config',
      },
    });
  } catch (error) {
    captureException(error, {
      tags: { source: 'posthog_security_agent_config_saved' },
      extra: { properties },
    });
  }
}

/**
 * Track security agent sync operation
 */
export function trackSecurityAgentSync(properties: SecurityAgentSyncEvent): void {
  try {
    posthogClient.capture({
      distinctId: properties.distinctId,
      event: 'security_agent_sync',
      properties: {
        ...properties,
        feature: 'security-agent',
        operation: 'sync',
      },
    });
  } catch (error) {
    captureException(error, {
      tags: { source: 'posthog_security_agent_sync' },
      extra: { properties },
    });
  }
}

/**
 * Track security agent analysis started
 */
export function trackSecurityAgentAnalysisStarted(
  properties: SecurityAgentAnalysisStartedEvent
): void {
  try {
    posthogClient.capture({
      distinctId: properties.distinctId,
      event: 'security_agent_analysis_started',
      properties: {
        ...properties,
        feature: 'security-agent',
        operation: 'start_analysis',
      },
    });
  } catch (error) {
    captureException(error, {
      tags: { source: 'posthog_security_agent_analysis_started' },
      extra: { properties },
    });
  }
}

/**
 * Track security agent analysis completed
 */
export function trackSecurityAgentAnalysisCompleted(
  properties: SecurityAgentAnalysisCompletedEvent
): void {
  try {
    posthogClient.capture({
      distinctId: properties.distinctId,
      event: 'security_agent_analysis_completed',
      properties: {
        ...properties,
        feature: 'security-agent',
        operation: 'analysis_completed',
      },
    });
  } catch (error) {
    captureException(error, {
      tags: { source: 'posthog_security_agent_analysis_completed' },
      extra: { properties },
    });
  }
}

/**
 * Track security finding manually dismissed
 */
export function trackSecurityAgentFindingDismissed(
  properties: SecurityAgentFindingDismissedEvent
): void {
  try {
    posthogClient.capture({
      distinctId: properties.distinctId,
      event: 'security_agent_finding_dismissed',
      properties: {
        ...properties,
        feature: 'security-agent',
        operation: 'dismiss_finding',
      },
    });
  } catch (error) {
    captureException(error, {
      tags: { source: 'posthog_security_agent_finding_dismissed' },
      extra: { properties },
    });
  }
}

/**
 * Track security finding auto-dismissed
 */
export function trackSecurityAgentAutoDismiss(properties: SecurityAgentAutoDismissEvent): void {
  try {
    posthogClient.capture({
      distinctId: properties.distinctId,
      event: 'security_agent_auto_dismiss',
      properties: {
        ...properties,
        feature: 'security-agent',
        operation: 'auto_dismiss',
      },
    });
  } catch (error) {
    captureException(error, {
      tags: { source: 'posthog_security_agent_auto_dismiss' },
      extra: { properties },
    });
  }
}

/**
 * Track security agent full sync (cron job)
 */
export function trackSecurityAgentFullSync(properties: SecurityAgentFullSyncEvent): void {
  try {
    posthogClient.capture({
      distinctId: properties.distinctId,
      event: 'security_agent_full_sync',
      properties: {
        ...properties,
        feature: 'security-agent',
        operation: 'full_sync',
      },
    });
  } catch (error) {
    captureException(error, {
      tags: { source: 'posthog_security_agent_full_sync' },
      extra: { properties },
    });
  }
}
