/**
 * PostHog tracking for shell security feature.
 *
 * Tracks scan completions for product analytics, conversion attribution,
 * and usage reporting. Events follow the wide-event pattern used by security-agent.
 */

import 'server-only';
import PostHogClient from '@/lib/posthog';
import { captureException } from '@sentry/nextjs';

const posthogClient = PostHogClient();

type BaseShellSecurityEvent = {
  distinctId: string;
  userId: string;
  organizationId?: string;
};

type ShellSecurityScanCompletedEvent = BaseShellSecurityEvent & {
  sourcePlatform: string;
  sourceMethod: string;
  pluginVersion?: string;
  openclawVersion?: string;
  findingsCritical: number;
  findingsWarn: number;
  findingsInfo: number;
  /** Overall letter grade (A–F) derived from the finding counts. */
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  /** Numeric score (0–100) that produced the letter grade. */
  score: number;
  publicIp?: string;
};

/**
 * Track a completed shell security scan.
 * Fired after the report is generated and the scan is recorded in the DB.
 */
export function trackShellSecurityScanCompleted(properties: ShellSecurityScanCompletedEvent): void {
  try {
    // The PostHog `event` name and the `feature` property are intentionally
    // kept as their pre-rename values (`security_advisor_*` / `security-advisor`)
    // so existing dashboards, funnels, and trend queries keep producing an
    // unbroken timeseries across the rename. Change only in coordination with
    // a dashboard migration. The Sentry `source` tag below is a separate
    // concern — it has no continuity requirement, so it tracks the module name.
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
      tags: { source: 'posthog_shell_security_scan_completed' },
      extra: { properties },
    });
  }
}
