'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  WastelandTRPCProvider,
  createWastelandTRPCClient,
} from '@/lib/wasteland/trpc';
import { WastelandDashboardHeader } from '@/app/(app)/wasteland/[wastelandId]/WastelandDashboardHeader';

export default function OrgWastelandLayout({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [trpcClient] = useState(() => createWastelandTRPCClient());

  return (
    <WastelandTRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
      <div className="flex h-full flex-col">
        <WastelandDashboardHeader />
        <div className="flex-1 overflow-hidden">{children}</div>
      </div>
    </WastelandTRPCProvider>
  );
}
