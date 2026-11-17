import { TRPCError } from '@trpc/server';
import { fetchRequestHandler, type FetchCreateContextFnOptions } from '@trpc/server/adapters/fetch';
import type { TRPCContext } from '@kilocode/web-shared/lib/trpc/init';
import { clientIpFromHeaders } from '@kilocode/web-shared/lib/admin/admin-access-log';
import { appShellProceduresRouter } from '@/routers/app-shell-procedures-router';
import { requireAppShellUser } from '@/lib/app-shell/session';

export const maxDuration = 800;

/**
 * The shell's own tRPC entry point. It resolves the caller from the shell
 * cookie (the only cookie scoped to `/app-shell`), refuses a cross-origin
 * caller, and mounts only the procedures shell pages call, so a shell session
 * cannot reach the rest of the web API. See `appShellProceduresRouter`.
 */
async function createAppShellTRPCContext({
  req,
}: FetchCreateContextFnOptions): Promise<TRPCContext> {
  const origin = req.headers.get('origin');
  if (origin && origin !== new URL(req.url).origin) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Cross-origin app-shell request' });
  }

  const user = await requireAppShellUser();
  if (!user) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'App-shell session required',
    });
  }

  const headersList = new Headers(req.headers);
  return { user, headersList, ip: clientIpFromHeaders(headersList) };
}

const handler = (req: Request) =>
  fetchRequestHandler({
    endpoint: '/app-shell/api/trpc',
    req,
    router: appShellProceduresRouter,
    createContext: createAppShellTRPCContext,
    allowMethodOverride: true,
  });

export { handler as GET, handler as POST };
