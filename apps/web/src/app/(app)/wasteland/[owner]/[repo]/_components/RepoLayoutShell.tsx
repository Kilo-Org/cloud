'use client';

import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  WastelandTRPCProvider,
  createWastelandTRPCClient,
  useWastelandTRPC,
} from '@/lib/wasteland/trpc';
import { HideAppTopbar } from '@/components/gastown/HideAppTopbar';
import { DrawerStackProvider } from '@/components/wasteland/drawer/WastelandDrawerStack';
import { renderWastelandDrawerContent } from '@/components/wasteland/drawer/renderDrawerContent';
import { WastelandPageHeaderProvider } from '@/app/(app)/wasteland/by-id/[wastelandId]/WastelandPageHeaderContext';
import { Skeleton } from '@/components/ui/skeleton';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { WastelandRepoProvider } from './WastelandRepoContext';
import { RepoDashboardHeader } from './RepoDashboardHeader';
import { NotConnectedShell } from './NotConnectedShell';

type RepoLayoutShellProps = {
  owner: string;
  repo: string;
  children: ReactNode;
};

/**
 * The top-level shell for /wasteland/[owner]/[repo]. Owns the tRPC
 * client, drawer stack, and page-header context, then resolves
 * `<owner>/<repo>` into a `wastelandId` and hands the resolved identity
 * down through `WastelandRepoProvider`.
 *
 * Flow:
 *   1. Loading: render a skeleton with no nav, so we don't flicker the
 *      tabs into a "not connected" state and back.
 *   2. Connected (resolveOwnerRepo returned an identity): render the
 *      dashboard header + nav + page content.
 *   3. Not connected (resolveOwnerRepo returned null): render the
 *      `NotConnectedShell` — Connect CTA only, no nav.
 */
export function RepoLayoutShell({ owner, repo, children }: RepoLayoutShellProps) {
  const queryClient = useQueryClient();
  const [trpcClient] = useState(() => createWastelandTRPCClient());

  return (
    <WastelandTRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
      <HideAppTopbar />
      <WastelandPageHeaderProvider>
        <DrawerStackProvider renderContent={renderWastelandDrawerContent}>
          <RepoLayoutShellInner owner={owner} repo={repo}>
            {children}
          </RepoLayoutShellInner>
        </DrawerStackProvider>
      </WastelandPageHeaderProvider>
    </WastelandTRPCProvider>
  );
}

function RepoLayoutShellInner({ owner, repo, children }: RepoLayoutShellProps) {
  const trpc = useWastelandTRPC();
  const resolveQuery = useQuery(trpc.wasteland.resolveOwnerRepo.queryOptions({ owner, repo }));

  if (resolveQuery.isLoading) {
    return (
      <div className="flex h-full flex-col">
        <header className="flex items-center gap-3 border-b border-white/[0.06] px-4 py-3">
          <SidebarTrigger className="-ml-1" />
          <Skeleton className="h-5 w-48" />
        </header>
        <div className="flex-1" />
      </div>
    );
  }

  const resolved = resolveQuery.data;
  if (!resolved) {
    return <NotConnectedShell owner={owner} repo={repo} />;
  }

  return (
    <WastelandRepoProvider
      value={{
        owner,
        repo,
        wastelandId: resolved.wastelandId,
        ownerType: resolved.ownerType,
        ownerUserId: resolved.ownerUserId,
        organizationId: resolved.organizationId,
        name: resolved.name,
      }}
    >
      <div className="flex h-full flex-col">
        <RepoDashboardHeader owner={owner} repo={repo} />
        <div className="flex-1 overflow-hidden">{children}</div>
      </div>
    </WastelandRepoProvider>
  );
}
