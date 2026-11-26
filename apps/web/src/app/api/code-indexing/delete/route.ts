import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import {
  assertMinimumAppVersion,
  contextAuthRefusal,
  readContextAuth,
} from '@kilocode/web-shared/lib/trpc/init';
import { logTRPCError } from '@kilocode/web-shared/lib/trpc/error-utils';
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

/**
 * POST /api/code-indexing/delete
 *
 * Deletes indexed files of one project. The handler builds its REST context
 * from its own authentication, headers and method, so a staff branch admits as
 * this request (its pathname and `POST`) rather than as the tRPC procedure.
 * It keeps the answers of the tRPC adapter it replaced: the budgeted context
 * auth read and its account refusals (401, or 403 for a blocked mobile
 * account), the refusal of a Cloud Agent authority, the mobile minimum-version
 * gate, and each procedure error's status. An ordinary failure answers
 * `{ success: false }`, as before.
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

  try {
    const auth = await readContextAuth({
      headersList: request.headers,
      requestPathname: request.nextUrl.pathname,
    });
    const refusal = contextAuthRefusal(auth, request.headers);
    if (refusal !== null || auth.authFailedResponse) {
      throw refusal ?? contextAuthRefusal({ user: null }, null);
    }
    // The tRPC adapter refused every Cloud Agent authority this procedure is
    // not granted to, and no authority grants a REST route. The credential
    // helper already rejects such a token for this pathname; this keeps the
    // route closed to one, with the middleware's answer, if that ever changes.
    if (auth.cloudAgentAuthority !== undefined) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Cloud Agent authority denied' });
    }
    await assertMinimumAppVersion(request.headers);

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
    return NextResponse.json(await deleteCodeIndexFiles(ctx, input.data));
  } catch (error) {
    if (error instanceof TRPCError) {
      // A refused staff admission keeps the adapter's status and step-up
      // detail; it happens before any index change.
      if (error.cause instanceof StaffRequestRefusal) {
        return error.cause.response;
      }
      logTRPCError(error, { extra: { url: request.url, method: request.method } });
      return NextResponse.json(
        { error: error.message, message: error.message },
        { status: getHTTPStatusCodeFromError(error) }
      );
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
