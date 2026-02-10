import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { captureException } from '@sentry/nextjs';
import {
  CRON_SECRET,
  BETTERSTACK_API_TOKEN,
  BETTERSTACK_STATUS_PAGE_ID,
  BETTERSTACK_GITHUB_RESOURCE_IDS,
} from '@/lib/config.server';
import { sentryLogger } from '@/lib/utils.server';

const log = sentryLogger('github-status-sync', 'info');
const logError = sentryLogger('github-status-sync', 'error');
const cronWarn = sentryLogger('cron', 'warning');

// --- GitHub Status API types ---

interface GitHubStatusResponse {
  status: {
    indicator: 'none' | 'minor' | 'major' | 'critical';
    description: string;
  };
  components: GitHubComponent[];
}

interface GitHubComponent {
  id: string;
  name: string;
  status: 'operational' | 'degraded_performance' | 'partial_outage' | 'major_outage';
  description: string | null;
}

// --- Betterstack API types ---

interface BetterstackReport {
  id: string;
  attributes: {
    title: string;
    report_type: string;
    starts_at: string;
    resolved_at: string | null;
    aggregate_state: string;
    status_page_id: number;
  };
}

interface BetterstackListResponse {
  data: BetterstackReport[];
}

// --- Constants ---

const GITHUB_STATUS_API = 'https://www.githubstatus.com/api/v2/summary.json';
const BETTERSTACK_BASE = 'https://uptime.betterstack.com/api/v2';
const REPORT_TITLE_PREFIX = '[Auto] GitHub Outage';

/** GitHub components most relevant to Kilo features (cloud agents, code reviewer, security agent) */
const RELEVANT_GITHUB_COMPONENTS = new Set([
  'API Requests',
  'Webhooks',
  'Git Operations',
  'Actions',
  'Pull Requests',
  'Issues',
]);

// --- Helpers ---

function mapGitHubStatusToBetterstack(
  status: GitHubComponent['status']
): 'degraded' | 'downtime' | null {
  switch (status) {
    case 'degraded_performance':
    case 'partial_outage':
      return 'degraded';
    case 'major_outage':
      return 'downtime';
    default:
      return null;
  }
}

/** Return the worst Betterstack status from a list, or null if all operational. */
function worstStatus(statuses: ('degraded' | 'downtime')[]): 'degraded' | 'downtime' | null {
  if (statuses.includes('downtime')) return 'downtime';
  if (statuses.includes('degraded')) return 'degraded';
  return null;
}

async function fetchGitHubStatus(): Promise<GitHubStatusResponse> {
  const res = await fetch(GITHUB_STATUS_API, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`GitHub status API returned ${res.status}`);
  return res.json() as Promise<GitHubStatusResponse>;
}

async function betterstackFetch(path: string, options: RequestInit = {}) {
  return fetch(`${BETTERSTACK_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${BETTERSTACK_API_TOKEN}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
    signal: AbortSignal.timeout(10_000),
  });
}

/** Find an unresolved auto-created report on the status page. */
async function findActiveReport(): Promise<BetterstackReport | null> {
  const res = await betterstackFetch(`/status-pages/${BETTERSTACK_STATUS_PAGE_ID}/status-reports`);
  if (!res.ok) throw new Error(`Betterstack list reports returned ${res.status}`);
  const body = (await res.json()) as BetterstackListResponse;

  return (
    body.data.find(
      r => r.attributes.title.startsWith(REPORT_TITLE_PREFIX) && r.attributes.resolved_at === null
    ) ?? null
  );
}

/** Create a new status report on Betterstack. */
async function createReport(
  title: string,
  message: string,
  resourceIds: string[],
  status: 'degraded' | 'downtime'
) {
  const res = await betterstackFetch(`/status-pages/${BETTERSTACK_STATUS_PAGE_ID}/status-reports`, {
    method: 'POST',
    body: JSON.stringify({
      title,
      message,
      report_type: 'manual',
      affected_resources: resourceIds.map(id => ({
        status_page_resource_id: id,
        status,
      })),
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Betterstack create report failed (${res.status}): ${body}`);
  }
  return res.json();
}

/** Add a status update to an existing report (e.g. to resolve it or change severity). */
async function addStatusUpdate(
  reportId: string,
  message: string,
  resourceIds: string[],
  status: 'degraded' | 'downtime' | 'resolved'
) {
  const res = await betterstackFetch(
    `/status-pages/${BETTERSTACK_STATUS_PAGE_ID}/status-reports/${reportId}/status-updates`,
    {
      method: 'POST',
      body: JSON.stringify({
        message,
        affected_resources: resourceIds.map(id => ({
          status_page_resource_id: id,
          status,
        })),
      }),
    }
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Betterstack add status update failed (${res.status}): ${body}`);
  }
  return res.json();
}

// --- Main handler ---

export async function GET(request: NextRequest) {
  try {
    // Auth
    const authHeader = request.headers.get('authorization');
    if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
      cronWarn(
        'SECURITY: Invalid CRON job authorization attempt: ' +
          (authHeader ? 'Invalid authorization header' : 'Missing authorization header')
      );
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Validate config
    if (!BETTERSTACK_API_TOKEN || !BETTERSTACK_STATUS_PAGE_ID || !BETTERSTACK_GITHUB_RESOURCE_IDS) {
      return NextResponse.json(
        { error: 'Missing Betterstack configuration env vars' },
        { status: 500 }
      );
    }

    const resourceIds = BETTERSTACK_GITHUB_RESOURCE_IDS.split(',').map(id => id.trim());

    // 1. Fetch current GitHub status
    const ghStatus = await fetchGitHubStatus();
    const affectedComponents = ghStatus.components.filter(
      c => RELEVANT_GITHUB_COMPONENTS.has(c.name) && c.status !== 'operational'
    );

    const mappedStatuses = affectedComponents
      .map(c => mapGitHubStatusToBetterstack(c.status))
      .filter((s): s is 'degraded' | 'downtime' => s !== null);

    const currentSeverity = worstStatus(mappedStatuses);

    // 2. Check for existing active report on Betterstack
    const activeReport = await findActiveReport();

    // 3. Decide action
    if (currentSeverity && !activeReport) {
      // GitHub is having issues and we haven't reported yet → create report
      const componentNames = affectedComponents.map(c => c.name).join(', ');
      const title = `${REPORT_TITLE_PREFIX} — ${componentNames}`;
      const message =
        `GitHub is reporting issues with: ${componentNames}. ` +
        `This may affect cloud agents, code reviewer, and security agent functionality. ` +
        `Details: https://www.githubstatus.com`;

      await createReport(title, message, resourceIds, currentSeverity);
      log('Created Betterstack status report', { currentSeverity, componentNames });
    } else if (currentSeverity && activeReport) {
      // GitHub still has issues — update if severity changed
      const currentAggState = activeReport.attributes.aggregate_state;
      if (currentAggState !== currentSeverity) {
        const componentNames = affectedComponents.map(c => c.name).join(', ');
        const message =
          `GitHub status updated — affected components: ${componentNames}. ` +
          `Severity: ${currentSeverity}. Details: https://www.githubstatus.com`;

        await addStatusUpdate(activeReport.id, message, resourceIds, currentSeverity);
        log('Updated Betterstack status report severity', {
          reportId: activeReport.id,
          from: currentAggState,
          to: currentSeverity,
        });
      } else {
        log('GitHub still degraded, no status change needed', { currentSeverity });
      }
    } else if (!currentSeverity && activeReport) {
      // GitHub recovered → resolve the report
      const message =
        'GitHub has recovered and all monitored components are operational. ' +
        'Cloud agents, code reviewer, and security agent should be fully functional.';

      await addStatusUpdate(activeReport.id, message, resourceIds, 'resolved');
      log('Resolved Betterstack status report', { reportId: activeReport.id });
    } else {
      // All good, nothing to do
      log('GitHub status operational, no action needed');
    }

    return NextResponse.json({
      success: true,
      githubIndicator: ghStatus.status.indicator,
      affectedComponents: affectedComponents.map(c => ({
        name: c.name,
        status: c.status,
      })),
      action: currentSeverity
        ? activeReport
          ? 'checked_existing'
          : 'created_report'
        : activeReport
          ? 'resolved_report'
          : 'no_action',
    });
  } catch (error) {
    logError('Error syncing GitHub status', { error });
    captureException(error, {
      tags: { endpoint: 'cron/sync-github-status' },
    });

    return NextResponse.json(
      {
        success: false,
        error: 'Failed to sync GitHub status',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
