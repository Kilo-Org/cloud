'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { WastelandTRPCProvider, createWastelandTRPCClient } from '@/lib/wasteland/trpc';
import { HideAppTopbar } from '@/components/gastown/HideAppTopbar';
import { WastelandDashboardHeader } from '@/app/(app)/wasteland/by-id/[wastelandId]/WastelandDashboardHeader';
import { WastelandPageHeaderProvider } from '@/app/(app)/wasteland/by-id/[wastelandId]/WastelandPageHeaderContext';

export default function OrgWastelandLayout({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [trpcClient] = useState(() => createWastelandTRPCClient());

  return (
    <WastelandTRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
      <WastelandPageHeaderProvider>
        <HideAppTopbar />
        <div className="flex h-full flex-col">
          <WastelandDashboardHeader />
          <div className="flex-1 overflow-hidden">{children}</div>
        </div>
      </WastelandPageHeaderProvider>
    </WastelandTRPCProvider>
  );
}
