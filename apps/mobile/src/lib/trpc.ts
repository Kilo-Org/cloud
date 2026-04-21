import { type RootRouter } from '@kilocode/trpc';
import { createTRPCClient, httpBatchLink, httpLink, splitLink } from '@trpc/client';
import { createTRPCContext } from '@trpc/tanstack-react-query';
import * as SecureStore from 'expo-secure-store';

import { API_BASE_URL } from '@/lib/config';
import { AUTH_TOKEN_KEY } from '@/lib/storage-keys';

export const { TRPCProvider, useTRPC } = createTRPCContext<RootRouter>();

const trpcUrl = `${API_BASE_URL}/api/trpc`;

async function getAuthHeaders() {
  const token = await SecureStore.getItemAsync(AUTH_TOKEN_KEY);
  if (!token) {
    return {};
  }
  return { Authorization: `Bearer ${token}` };
}

export const trpcClient = createTRPCClient<RootRouter>({
  links: [
    splitLink({
      condition: op => op.context.skipBatch === true,
      true: httpLink({
        url: trpcUrl,
        headers: getAuthHeaders,
      }),
      false: httpBatchLink({
        url: trpcUrl,
        headers: getAuthHeaders,
      }),
    }),
  ],
});
