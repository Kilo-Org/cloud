'use client';

import { useQuery } from '@tanstack/react-query';
import { getProviders } from 'next-auth/react';

export function useClaudeSignInConfigured(): boolean {
  const { data } = useQuery({
    queryKey: ['auth', 'configured-providers'],
    queryFn: getProviders,
    staleTime: 30_000,
    retry: 1,
  });
  return Boolean(data?.claude);
}
