'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { WastelandTRPCProvider, createWastelandTRPCClient } from '@/lib/wasteland/trpc';
import { HideAppTopbar } from '@/components/gastown/HideAppTopbar';
import { DrawerStackProvider } from '@/components/wasteland/drawer/WastelandDrawerStack';
import { renderWastelandDrawerContent } from '@/components/wasteland/drawer/renderDrawerContent';
import { WastelandDashboardHeader } from './WastelandDashboardHeader';
import { WastelandPageHeaderProvider } from './WastelandPageHeaderContext';

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
