import 'server-only';
import { NextResponse } from 'next/server';
import { TRPCError } from '@trpc/server';
import { RequestDeadlineError, withDeadline } from '@kilocode/event-service';

export function homeWidgetJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store, private', Pragma: 'no-cache' },
  });
}

/** Bound auth, source reads, and registration even without foreground-app headers. */
export async function homeWidgetRequest(work: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await withDeadline(10_000, work);
  } catch (error) {
    if (error instanceof TRPCError) {
      const status =
        error.code === 'UNAUTHORIZED'
          ? 401
          : error.code === 'FORBIDDEN'
            ? 403
            : error.code === 'BAD_REQUEST'
              ? 400
              : error.code === 'CONFLICT'
                ? 409
                : 503;
      return homeWidgetJson(
        { error: status === 401 || status === 403 ? 'Unauthorized' : 'Widget request failed' },
        status
      );
    }
    return homeWidgetJson(
      { error: 'Widget request failed' },
      error instanceof RequestDeadlineError ? 504 : 503
    );
  }
}
