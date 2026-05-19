'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { WastelandTRPCProvider, createWastelandTRPCClient } from '@/lib/wasteland/trpc';
import { HideAppTopbar } from '@/components/gastown/HideAppTopbar';
import { DrawerStackProvider } from '@/components/wasteland/drawer/WastelandDrawerStack';
import { renderWastelandDrawerContent } from '@/components/wasteland/drawer/renderDrawerContent';
import { WastelandDashboardHeader } from './WastelandDashboardHeader';
import { WastelandPageHeaderProvider } from './WastelandPageHeaderContext';

/**
 * Layout for /wasteland/by-id/[wastelandId]/... — the legacy
 * UUID-keyed wasteland tree.
 *
 * The owner/repo-keyed M2.2 tree lives at /wasteland/[owner]/[repo]/...
 * (a separate sibling under /wasteland/). Legacy URLs in the form
 * `/wasteland/<uuid>/<rest>` are rewritten to `/wasteland/by-id/<uuid>/<rest>`
 * by the root `middleware.ts`, so existing links keep working without
 * needing any UUID-detection branching here.
 */
export default function WastelandLayout({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [trpcClient] = useState(() => createWastelandTRPCClient());

  return (
    <WastelandTRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
      <HideAppTopbar />
      <WastelandPageHeaderProvider>
        <DrawerStackProvider renderContent={renderWastelandDrawerContent}>
          <div className="flex h-full flex-col">
            <WastelandDashboardHeader />
            <div className="flex-1 overflow-hidden">{children}</div>
          </div>
        </DrawerStackProvider>
      </WastelandPageHeaderProvider>
    </WastelandTRPCProvider>
  );
}
