'use client';

import { TRPCContext } from '@/lib/trpc/client';

/**
 * Shell pages call tRPC through `/app-shell/api/trpc` instead of `/api/trpc`:
 * the shell session cookie is scoped to `/app-shell`, so the main entry point
 * never sees it, and this entry point never accepts a full web session.
 */
export function ShellProviders({ children }: { children: React.ReactNode }) {
  return <TRPCContext endpoint="/app-shell/api/trpc">{children}</TRPCContext>;
}
