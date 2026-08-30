import { NextResponse, after, type NextRequest } from 'next/server';
import { getUserFromAuth } from '@/lib/user/server';
import { wrapInSafeNextResponse } from '@/lib/ai-gateway/llm-proxy-helpers';
import { captureException } from '@sentry/nextjs';
import { validateFeatureHeader, FEATURE_HEADER } from '@/lib/feature-detection';
import { EXA_ALLOWED_PATHS, isExaAllowedPath } from '@/lib/exa-paths';
import { extractExaCostMicrodollars, prepareExaRequest } from '@/lib/exa-provider';

export async function POST(request: NextRequest) {
  const { user, authFailedResponse, organizationId } = await getUserFromAuth({ adminOnly: false });
  if (authFailedResponse) return authFailedResponse;
  const url = new URL(request.url);
  const prefix = '/api/exa';
  const exaPath = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : '';
  if (!isExaAllowedPath(exaPath)) {
    return NextResponse.json(
      { error: `Invalid path. Allowed: ${EXA_ALLOWED_PATHS.join(', ')}` },
      { status: 400 }
    );
  }
  const provider = await prepareExaRequest(user, organizationId);
  if (provider instanceof Response) return provider;
  // Old proxy callers retain their body, response, and asynchronous billing contracts until retirement.
  const requestBody: Record<string, unknown> = await request.json();
  delete requestBody.stream;
  const featureId = validateFeatureHeader(request.headers.get(FEATURE_HEADER)) ?? undefined;
  const type = typeof requestBody.type === 'string' ? requestBody.type : undefined;
  const response = await provider.send(exaPath, requestBody, request.signal);
  const cloned = response.clone();
  after(async () => {
    if (response.status >= 400) return;
    try {
      await provider.record(
        exaPath,
        extractExaCostMicrodollars(await cloned.json()),
        featureId,
        type
      );
    } catch (error) {
      captureException(error, {
        tags: { route: '/api/exa/[...path]', exaPath },
        extra: { userId: user.id, responseStatus: response.status },
      });
    }
  });
  return wrapInSafeNextResponse(response);
}
