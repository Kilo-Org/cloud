import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { after } from 'next/server';
import * as z from 'zod';
import { getUserFromAuth } from '@/lib/user.server';
import { captureException } from '@sentry/nextjs';
import {
  SecurityAdvisorRequestSchema,
  API_VERSION,
  RATE_LIMIT_PER_DAY,
  type SecurityAdvisorError,
  type SecurityAdvisorResponse,
} from '@/lib/security-advisor/schemas';
import { generateSecurityReport } from '@/lib/security-advisor/report-generator';
import {
  checkSecurityAdvisorRateLimit,
  recordSecurityAdvisorScan,
} from '@/lib/security-advisor/rate-limiter';
import { trackSecurityAdvisorScanCompleted } from '@/lib/security-advisor/posthog-tracking';

function errorResponse(
  code: SecurityAdvisorError['error']['code'],
  message: string,
  status: number,
  retryAfter?: number
): NextResponse<SecurityAdvisorError> {
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
  const parseResult = SecurityAdvisorRequestSchema.safeParse(body);
  if (!parseResult.success) {
    return errorResponse(
      'invalid_payload',
      `Invalid request body: ${z.treeifyError(parseResult.error)}`,
      400
    );
  }

  const payload = parseResult.data;

  // 5. Rate limit (DB-backed, survives restarts, shared across replicas)
  const rateLimit = await checkSecurityAdvisorRateLimit(user.id);
  if (!rateLimit.allowed) {
    return errorResponse(
      'rate_limited',
      `Rate limit exceeded. You can run ${RATE_LIMIT_PER_DAY} scans per day.`,
      429
    );
  }

  // 6. Generate report
  const isKiloClaw = payload.source.platform === 'kiloclaw';
  const report = generateSecurityReport({
    audit: payload.audit,
    publicIp: payload.publicIp,
    isKiloClaw,
  });

  // 7. Record scan in DB and fire PostHog event (non-blocking)
  after(async () => {
    try {
      await recordSecurityAdvisorScan(user.id, organizationId ?? undefined, payload);

      trackSecurityAdvisorScanCompleted({
        distinctId: user.id,
        userId: user.id,
        organizationId: organizationId ?? undefined,
        sourcePlatform: payload.source.platform,
        sourceMethod: payload.source.method,
        pluginVersion: payload.source.pluginVersion,
        openclawVersion: payload.source.openclawVersion,
        findingsCritical: payload.audit.summary.critical,
        findingsWarn: payload.audit.summary.warn,
        findingsInfo: payload.audit.summary.info,
        publicIp: payload.publicIp,
      });
    } catch (err) {
      captureException(err, { tags: { source: 'security_advisor_after_callback' } });
    }
  });

  // 8. Return structured response
  const response: SecurityAdvisorResponse = {
    apiVersion: API_VERSION,
    status: 'success',
    report: {
      markdown: report.markdown,
      summary: report.summary,
      findings: report.findings,
      recommendations: report.recommendations,
    },
  };

  return NextResponse.json(response);
}
