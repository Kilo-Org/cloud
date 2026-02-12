/**
 * Security Reviews - Dependabot API
 *
 * Fetch and manage Dependabot alerts from GitHub API.
 */

import { Octokit } from '@octokit/rest';
import { generateGitHubInstallationToken } from '@/lib/integrations/platforms/github/adapter';
import type { DependabotAlertRaw, DependabotAlertState } from '../core/types';
import { sentryLogger } from '@/lib/utils.server';

const log = sentryLogger('security-agent:dependabot-api', 'info');
const warn = sentryLogger('security-agent:dependabot-api', 'warning');
const logError = sentryLogger('security-agent:dependabot-api', 'error');

/**
 * Dependabot alert from GitHub API
 * This is the raw response type from the API
 */
type GitHubDependabotAlert = {
  number: number;
  state: string;
  dependency: {
    package: {
      ecosystem: string;
      name: string;
    };
    manifest_path: string;
    scope: string;
  };
  security_advisory: {
    ghsa_id: string;
    cve_id: string | null;
    summary: string;
    description: string;
    severity: string;
    cvss?: {
      score: number;
      vector_string: string;
    };
    cwes?: Array<{
      cwe_id: string;
      name: string;
    }>;
  };
  security_vulnerability: {
    vulnerable_version_range: string;
    first_patched_version?: {
      identifier: string;
    };
  };
  created_at: string;
  updated_at: string;
  fixed_at: string | null;
  dismissed_at: string | null;
  dismissed_by?: {
    login: string;
  } | null;
  dismissed_reason?: string | null;
  dismissed_comment?: string | null;
  auto_dismissed_at?: string | null;
  html_url: string;
  url: string;
};

/**
 * Convert GitHub API response to our internal type
 */
function toInternalAlert(alert: GitHubDependabotAlert): DependabotAlertRaw {
  return {
    number: alert.number,
    state: alert.state as DependabotAlertState,
    dependency: {
      package: {
        ecosystem: alert.dependency.package.ecosystem,
        name: alert.dependency.package.name,
      },
      manifest_path: alert.dependency.manifest_path,
      scope: alert.dependency.scope as 'development' | 'runtime',
    },
    security_advisory: {
      ghsa_id: alert.security_advisory.ghsa_id,
      cve_id: alert.security_advisory.cve_id,
      summary: alert.security_advisory.summary,
      description: alert.security_advisory.description,
      severity: alert.security_advisory
        .severity as DependabotAlertRaw['security_advisory']['severity'],
      cvss: alert.security_advisory.cvss,
      cwes: alert.security_advisory.cwes,
    },
    security_vulnerability: {
      vulnerable_version_range: alert.security_vulnerability.vulnerable_version_range,
      first_patched_version: alert.security_vulnerability.first_patched_version,
    },
    created_at: alert.created_at,
    updated_at: alert.updated_at,
    fixed_at: alert.fixed_at,
    dismissed_at: alert.dismissed_at,
    dismissed_by: alert.dismissed_by,
    dismissed_reason: alert.dismissed_reason,
    dismissed_comment: alert.dismissed_comment,
    auto_dismissed_at: alert.auto_dismissed_at,
    html_url: alert.html_url,
    url: alert.url,
  };
}

/**
 * Fetch ALL Dependabot alerts for a repository (including fixed/dismissed)
 * This is used for full sync to capture complete history.
 * Uses Octokit's paginate helper for cursor-based pagination (GitHub Dependabot API
 * does not support page-based pagination).
 */
export async function fetchAllDependabotAlerts(
  installationId: string,
  owner: string,
  repo: string
): Promise<DependabotAlertRaw[]> {
  log(`Fetching alerts for ${owner}/${repo}`, { installationId });

  const apiStartTime = performance.now();
  const tokenData = await generateGitHubInstallationToken(installationId);
  const octokit = new Octokit({ auth: tokenData.token });

  try {
    // Use Octokit's paginate helper which handles cursor-based pagination automatically
    // The Dependabot API does not support the `page` parameter
    const data = await octokit.paginate(
      octokit.rest.dependabot.listAlertsForRepo,
      {
        owner,
        repo,
        per_page: 100,
        // No state filter - get all alerts including fixed/dismissed
      },
      response => {
        // Track rate limit on each page response
        const remaining = response.headers['x-ratelimit-remaining'];
        const limit = response.headers['x-ratelimit-limit'];
        if (remaining !== undefined && Number(remaining) < 100) {
          warn(`GitHub API rate limit low: ${remaining}/${limit} remaining`, {
            repo: `${owner}/${repo}`,
          });
        }
        return response.data;
      }
    );

    const apiDurationMs = Math.round(performance.now() - apiStartTime);
    const alerts = data.map(alert => toInternalAlert(alert as unknown as GitHubDependabotAlert));

    log(`Alerts fetched for ${owner}/${repo}`, {
      alertCount: alerts.length,
      durationMs: apiDurationMs,
    });

    return alerts;
  } catch (error) {
    const apiDurationMs = Math.round(performance.now() - apiStartTime);
    const status = (error as { status?: number }).status;
    const message = (error as { message?: string }).message;

    // Handle case where Dependabot alerts are disabled for the repository
    if (status === 403 && message?.includes('Dependabot alerts are disabled')) {
      log(`Dependabot alerts are disabled for ${owner}/${repo}, skipping`);
      return [];
    }

    logError(`Error fetching alerts for ${owner}/${repo}`, {
      status,
      message,
      durationMs: apiDurationMs,
    });
    throw error;
  }
}

/**
 * Fetch only open Dependabot alerts for a repository
 * This is used for quick checks of current vulnerabilities.
 * Uses Octokit's paginate helper for cursor-based pagination.
 */
export async function fetchOpenDependabotAlerts(
  installationId: string,
  owner: string,
  repo: string
): Promise<DependabotAlertRaw[]> {
  const tokenData = await generateGitHubInstallationToken(installationId);
  const octokit = new Octokit({ auth: tokenData.token });

  // Use Octokit's paginate helper which handles cursor-based pagination automatically
  const data = await octokit.paginate(octokit.rest.dependabot.listAlertsForRepo, {
    owner,
    repo,
    state: 'open',
    per_page: 100,
  });

  return data.map(alert => toInternalAlert(alert as unknown as GitHubDependabotAlert));
}

/**
 * Fetch a single Dependabot alert by number
 */
export async function fetchDependabotAlert(
  installationId: string,
  owner: string,
  repo: string,
  alertNumber: number
): Promise<DependabotAlertRaw | null> {
  const tokenData = await generateGitHubInstallationToken(installationId);
  const octokit = new Octokit({ auth: tokenData.token });

  try {
    const { data } = await octokit.rest.dependabot.getAlert({
      owner,
      repo,
      alert_number: alertNumber,
    });

    return toInternalAlert(data as unknown as GitHubDependabotAlert);
  } catch (error) {
    // Return null if alert not found
    if ((error as { status?: number }).status === 404) {
      return null;
    }
    throw error;
  }
}

/**
 * Dismiss reason types for Dependabot alerts
 */
export type DependabotDismissReason =
  | 'fix_started'
  | 'no_bandwidth'
  | 'tolerable_risk'
  | 'inaccurate'
  | 'not_used';

/**
 * Dismiss a Dependabot alert
 * Uses octokit.rest.dependabot.updateAlert() with state: 'dismissed'
 */
export async function dismissDependabotAlert(
  installationId: string,
  owner: string,
  repo: string,
  alertNumber: number,
  dismissedReason: DependabotDismissReason,
  dismissedComment?: string
): Promise<void> {
  const tokenData = await generateGitHubInstallationToken(installationId);
  const octokit = new Octokit({ auth: tokenData.token });

  await octokit.rest.dependabot.updateAlert({
    owner,
    repo,
    alert_number: alertNumber,
    state: 'dismissed',
    dismissed_reason: dismissedReason,
    dismissed_comment: dismissedComment,
  });
}

/**
 * Check if Dependabot is enabled for a repository
 * Returns true if we can successfully fetch alerts (even if empty)
 */
export async function isDependabotEnabled(
  installationId: string,
  owner: string,
  repo: string
): Promise<boolean> {
  const tokenData = await generateGitHubInstallationToken(installationId);
  const octokit = new Octokit({ auth: tokenData.token });

  try {
    // Try to fetch alerts - if it succeeds, Dependabot is enabled
    await octokit.rest.dependabot.listAlertsForRepo({
      owner,
      repo,
      per_page: 1,
    });
    return true;
  } catch (error) {
    // 403 or 404 typically means Dependabot is not enabled or no access
    const status = (error as { status?: number }).status;
    if (status === 403 || status === 404) {
      return false;
    }
    throw error;
  }
}
