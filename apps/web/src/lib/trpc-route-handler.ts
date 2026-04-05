import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import { createCallerFactory, createTRPCContext } from '@/lib/trpc/init';
import { rootRouter } from '@/routers/root-router';
import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';
import { logTRPCError } from '@/lib/trpc/error-utils';

const createCaller = createCallerFactory(rootRouter);

type ErrorResponse = { error: string; message?: string };

/**
 * Wraps a tRPC procedure call with standard error handling for Next.js API routes
 * @param request - The Next.js request object
 * @param handler - A function that receives the tRPC caller and returns the result
 * @returns A NextResponse with either the result or an error
 */
export async function handleTRPCRequest<TResult>(
  request: NextRequest,
  handler: (caller: ReturnType<typeof createCaller>) => Promise<TResult>
): Promise<NextResponse<ErrorResponse | TResult>> {
  try {
    // Create tRPC context and caller
    const ctx = await createTRPCContext();
    const caller = createCaller(ctx);

    // Execute the handler and return the result
    const result = await handler(caller);
    return NextResponse.json(result);
  } catch (error) {
    // Handle tRPC errors specifically
    if (error instanceof TRPCError) {
      logTRPCError(error, {
        extra: {
          url: request.url,
          method: request.method,
        },
      });
      const statusCode = getHTTPStatusCodeFromError(error);
      return NextResponse.json(
        { error: error.message, message: error.message },
        { status: statusCode }
      );
    } else {
      captureException(error);

      // Generic error response
      return NextResponse.json(
        {
          error: 'Internal Server Error',
          message: 'An error occurred while processing the request',
        },
        { status: 500 }
      );
    }
  }
}
