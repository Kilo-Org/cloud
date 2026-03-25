import { type RootRouter } from '@kilocode/trpc';
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import { createTRPCContext } from '@trpc/tanstack-react-query';
import * as SecureStore from 'expo-secure-store';

import { API_BASE_URL } from '@/lib/config';

export const { TRPCProvider, useTRPC } = createTRPCContext<RootRouter>();

export const trpcClient = createTRPCClient<RootRouter>({
  links: [
    httpBatchLink({
      url: `${API_BASE_URL}/api/trpc`,
      async headers() {
        const token = await SecureStore.getItemAsync('auth-token');
        if (!token) return {};
        return { Authorization: `Bearer ${token}` };
      },
    }),
  ],
});
