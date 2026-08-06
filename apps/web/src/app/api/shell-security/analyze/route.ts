import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { after } from 'next/server';
import * as z from 'zod';
import { getUserFromAuth } from '@/lib/user/server';
import { captureException } from '@sentry/nextjs';
import {
  ShellSecurityRequestSchema,
  API_VERSION,
  RATE_LIMIT_PER_DAY,
  type ShellSecurityError,
  type ShellSecurityResponse,
} from '@/lib/shell-security/schemas';
import {
  checkShellSecurityRateLimit,
  recordShellSecurityScan,
} from '@/lib/shell-security/rate-limiter';
import { trackShellSecurityScanCompleted } from '@/lib/shell-security/posthog-tracking';

// The shell-security plugin is end of life. Every published plugin version
// renders `report.markdown` verbatim in chat, so this endpoint now returns a
// static discontinuation notice instead of a generated report. It must stay a
// 200 success response: the plugin wraps error responses in "Security checkup
// failed unexpectedly" boilerplate, while the success path renders cleanly.
// Old plugin versions can never be forced to upgrade, so this endpoint (and
// its legacy /api/security-advisor/analyze alias) stays up indefinitely.
const EOL_MARKDOWN = `## The Kilo shell security checkup has been discontinued

This plugin no longer performs security analysis and will not receive updates.

You can remove it with:

\`\`\`
openclaw plugins uninstall shell-security
\`\`\`

For a managed OpenClaw environment that is secure by default, see [KiloClaw](https://kilo.ai/kiloclaw).
`;

// Zero findings maps to a clean grade in the old report generator, so A/100
// with empty findings is the most internally consistent stub for any non-plugin
// consumer that reads the structured fields.
const EOL_REPORT: ShellSecurityResponse['report'] = {
  markdown: EOL_MARKDOWN,
  grade: 'A',
  score: 100,
  summary: { critical: 0, warn: 0, info: 0, passed: 0 },
  findings: [],
  recommendations: [],
};

function errorResponse(
  code: ShellSecurityError['error']['code'],
  message: string,
  status: number,
  retryAfter?: number
): NextResponse<ShellSecurityError> {
  return NextResponse.json(
    {
      apiVersion: API_VERSION,
      status: 'error' as const,
      error: { code, message, ...(retryAfter !== undefined ? { retryAfter } : {}) },
    },
    { status }
  );
}

export async function POST(request: NextRequest) {
  // 1. Auth
  const { user, authFailedResponse, organizationId } = await getUserFromAuth({
    adminOnly: false,
  });
  if (authFailedResponse) return authFailedResponse;

  // 2. Parse body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse('invalid_payload', 'Invalid JSON body', 400);
  }

  // 3. Check apiVersion before full validation (better error message)
  if (typeof body === 'object' && body !== null && 'apiVersion' in body) {
    if ((body as Record<string, unknown>).apiVersion !== API_VERSION) {
      return errorResponse(
        'invalid_api_version',
        `Unsupported API version. Expected "${API_VERSION}".`,
        400
      );
    }
  }

  // 4. Validate payload
  const parseResult = ShellSecurityRequestSchema.safeParse(body);
  if (!parseResult.success) {
    return errorResponse(
      'invalid_payload',
      `Invalid request body: ${JSON.stringify(z.treeifyError(parseResult.error))}`,
      400
    );
  }

  const payload = parseResult.data;

  // Log the incoming version fingerprint so we have day-1 observability of
  // what plugin and OpenClaw versions are calling us. We don't branch on
  // this yet, but future schema changes will use these values to decide
  // how to interpret a given payload.
  console.log('[ShellSecurity] scan', {
    userId: user.id,
    pluginVersion: payload.source.pluginVersion,
    openclawVersion: payload.source.openclawVersion,
    sourcePlatform: payload.source.platform,
    sourceMethod: payload.source.method,
  });

  // 5. Rate limit (DB-backed, survives restarts, shared across replicas)
  const rateLimit = await checkShellSecurityRateLimit(user.id);
  if (!rateLimit.allowed) {
    return errorResponse(
      'rate_limited',
      `Rate limit exceeded. You can run ${RATE_LIMIT_PER_DAY} scans per day.`,
      429
    );
  }

  // 6. Record scan in DB (synchronous — must complete before response
  // so the rate limit counter is accurate under concurrent requests).
  // Scan rows are also how we measure remaining traffic before removing
  // the rest of the feature.
  await recordShellSecurityScan(user.id, organizationId ?? undefined, payload);

  // 7. Fire PostHog event (non-blocking — analytics don't need to block the
  // response). Kept so scan-volume dashboards keep working through the EOL
  // wind-down; finding counts reflect the stub report, not a real analysis.
  after(() => {
    try {
      trackShellSecurityScanCompleted({
        distinctId: user.id,
        userId: user.id,
        organizationId: organizationId ?? undefined,
        sourcePlatform: payload.source.platform,
        sourceMethod: payload.source.method,
        pluginVersion: payload.source.pluginVersion,
        openclawVersion: payload.source.openclawVersion,
        findingsCritical: EOL_REPORT.summary.critical,
        findingsWarn: EOL_REPORT.summary.warn,
        findingsInfo: EOL_REPORT.summary.info,
        grade: EOL_REPORT.grade,
        score: EOL_REPORT.score,
        publicIp: payload.publicIp,
      });
    } catch (err) {
      captureException(err, { tags: { source: 'shell_security_posthog' } });
    }
  });

  // 8. Return the static discontinuation notice
  const response: ShellSecurityResponse = {
    apiVersion: API_VERSION,
    status: 'success',
    report: EOL_REPORT,
  };

  return NextResponse.json(response);
}
