import { useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { useTRPC } from '@/lib/trpc';

type Cached = { token: string; expiresAt: number };

// Refetch 60s before expiry
const SAFETY_MARGIN_MS = 60_000;

export function useKiloChatToken() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const ref = useRef<Cached | null>(null);

  const getToken = useCallback(async (): Promise<string> => {
    const now = Date.now();
    if (ref.current && ref.current.expiresAt - now > SAFETY_MARGIN_MS) {
      return ref.current.token;
    }
    const data = await queryClient.fetchQuery(
      trpc.kiloChat.getToken.queryOptions(undefined, { staleTime: 0 })
    );
    ref.current = { token: data.token, expiresAt: new Date(data.expiresAt).getTime() };
    return data.token;
  }, [queryClient, trpc]);

  const invalidate = useCallback(() => {
    ref.current = null;
  }, []);

  return { getToken, invalidate };
}
