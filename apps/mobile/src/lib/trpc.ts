import { type MobileRouter } from '@kilocode/trpc/mobile';
import { createTRPCClient, httpBatchLink, httpLink, splitLink } from '@trpc/client';
import { createTRPCContext } from '@trpc/tanstack-react-query';
import * as SecureStore from 'expo-secure-store';

import { API_BASE_URL } from '@/lib/config';
import { AUTH_TOKEN_KEY } from '@/lib/storage-keys';

export const { TRPCProvider, useTRPC } = createTRPCContext<MobileRouter>();

const trpcUrl = `${API_BASE_URL}/api/trpc`;

async function getAuthHeaders() {
  const token = await SecureStore.getItemAsync(AUTH_TOKEN_KEY);
  if (!token) {
    return {};
  }
  return { Authorization: `Bearer ${token}` };
}

export const trpcClient = createTRPCClient<MobileRouter>({
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
