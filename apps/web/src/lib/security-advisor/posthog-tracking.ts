/**
 * PostHog tracking for security-advisor feature.
 *
 * Tracks scan completions for product analytics, conversion attribution,
 * and usage reporting. Events follow the wide-event pattern used by security-agent.
 */

import 'server-only';
import PostHogClient from '@/lib/posthog';
import { captureException } from '@sentry/nextjs';

const posthogClient = PostHogClient();

type BaseSecurityAdvisorEvent = {
  distinctId: string;
  userId: string;
  organizationId?: string;
};

type SecurityAdvisorScanCompletedEvent = BaseSecurityAdvisorEvent & {
  sourcePlatform: string;
  sourceMethod: string;
  pluginVersion?: string;
  openclawVersion?: string;
  findingsCritical: number;
  findingsWarn: number;
  findingsInfo: number;
  publicIp?: string;
};

/**
 * Track a completed security advisor scan.
 * Fired after the report is generated and the scan is recorded in the DB.
 */
export function trackSecurityAdvisorScanCompleted(
  properties: SecurityAdvisorScanCompletedEvent
): void {
  try {
    posthogClient.capture({
      distinctId: properties.distinctId,
      event: 'security_advisor_scan_completed',
      properties: {
        ...properties,
        feature: 'security-advisor',
        operation: 'scan_completed',
      },
    });
  } catch (error) {
    captureException(error, {
      tags: { source: 'posthog_security_advisor_scan_completed' },
      extra: { properties },
    });
  }
}
