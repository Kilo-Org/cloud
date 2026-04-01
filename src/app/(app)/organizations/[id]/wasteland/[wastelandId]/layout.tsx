'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  WastelandTRPCProvider,
  createWastelandTRPCClient,
} from '@/lib/wasteland/trpc';

export default function OrgWastelandLayout({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const [trpcClient] = useState(() => createWastelandTRPCClient());

  return (
    <WastelandTRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
      {children}
    </WastelandTRPCProvider>
  );
}
