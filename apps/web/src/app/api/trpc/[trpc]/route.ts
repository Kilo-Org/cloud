import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { createTRPCContext } from '@kilocode/web-shared/lib/trpc/init';
import { sessionCheckResponseHeaders } from '@kilocode/web-shared/lib/uts-bff/browser-session-config';
import { rootRouter } from '@/routers/root-router';

export const maxDuration = 800;

const handler = (req: Request) =>
  fetchRequestHandler({
    endpoint: '/api/trpc',
    req,
    router: rootRouter,
    createContext: createTRPCContext,
    // An unchecked UTS browser session answers 503; its `Retry-After` rides on the response.
    responseMeta: ({ errors }) => ({ headers: sessionCheckResponseHeaders(errors) }),
    allowMethodOverride: true,
    // A batched call answers 207 when one procedure fails, and folds the failure
    // into the response body. Without this the server log shows only the 207, so
    // nobody can tell which of a dozen batched procedures raised, or why.
    // Development only: production reporting is unchanged.
    onError:
      process.env.NODE_ENV === 'development'
        ? ({ path, type, error }) => {
            console.error(`[trpc] ${type} ${path ?? '<no path>'} failed: ${error.code}`);
          }
        : undefined,
  });

export { handler as GET, handler as POST };
