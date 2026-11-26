import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import { TRPCError } from '@trpc/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import {
  organizationRestAccessContext,
  StaffRequestRefusal,
} from '@kilocode/web-shared/routers/organizations/utils';
import { INVALID_JSON, readJsonBody } from '@/lib/invalid-json-body';
import {
  codeIndexingGoneResponse,
  isCodeIndexingEnabled,
} from '@/lib/code-indexing/availability.server';
import {
  CodebaseIndexingDeleteRequestSchema,
  deleteCodeIndexFiles,
} from '@/routers/code-indexing/code-indexing-router';

// The answer this route has always given a request without a usable account.
const UNAUTHENTICATED_MESSAGE = 'User not authenticated - no user to set on context';

/**
 * POST /api/code-indexing/delete
 *
 * Deletes indexed files of one project. The handler builds its REST context
 * from its own authentication, headers and method, so a staff branch admits as
 * this request (its pathname and `POST`) rather than as the tRPC procedure.
 * An ordinary failure answers `{ success: false }`, as before.
 */
export async function POST(request: NextRequest) {
  if (!isCodeIndexingEnabled()) {
    return codeIndexingGoneResponse();
  }

  const body = await readJsonBody(request);
  if (body === INVALID_JSON) {
    return NextResponse.json(
      { error: 'Invalid JSON body', message: 'Invalid JSON body' },
      { status: 400 }
    );
  }

  const auth = await getUserFromAuth({
    adminOnly: false,
    requestHeaders: request.headers,
    requestPathname: request.nextUrl.pathname,
  });
  if (auth.authFailedResponse) {
    return NextResponse.json(
      { error: UNAUTHENTICATED_MESSAGE, message: UNAUTHENTICATED_MESSAGE },
      { status: 401 }
    );
  }

  const input = CodebaseIndexingDeleteRequestSchema.safeParse(body);
  if (!input.success) {
    const message = input.error.issues
      .map(issue => `${issue.path.join('.')}: ${issue.message}`)
      .join(', ');
    return NextResponse.json({ error: 'Validation failed', message }, { status: 400 });
  }

  const ctx = organizationRestAccessContext(auth, {
    headers: request.headers,
    method: request.method,
  });
  try {
    return NextResponse.json(await deleteCodeIndexFiles(ctx, input.data));
  } catch (error) {
    // A refused staff admission keeps the adapter's status and step-up detail;
    // it happens before any index change.
    if (error instanceof TRPCError && error.cause instanceof StaffRequestRefusal) {
      return error.cause.response;
    }
    captureException(error, { extra: { url: request.url, method: request.method } });
    return NextResponse.json(
      {
        error: 'Internal Server Error',
        message: 'An error occurred while processing the request',
      },
      { status: 500 }
    );
  }
}
