import { describe, expect, it, vi } from 'vitest';

import { setTrpcUnauthorizedHandler } from '@/lib/auth/trpc-unauthorized';

import { createKiloAppQueryClient } from './query-client';

describe('createKiloAppQueryClient', () => {
  it('runs the registered unauthorized handler for mutation 401 errors', async () => {
    const signOut = vi.fn();
    const clear = setTrpcUnauthorizedHandler(signOut);
    const queryClient = createKiloAppQueryClient();
    const error = Object.assign(new Error('unauthorized'), { data: { httpStatus: 401 } });

    const mutation = queryClient.getMutationCache().build(queryClient, {
      mutationFn: async () => {
        await Promise.resolve();
        throw error;
      },
    });

    await expect(mutation.execute(undefined)).rejects.toBe(error);
    expect(signOut).toHaveBeenCalledTimes(1);
    clear();
  });

  it('runs the registered unauthorized handler for shaped mutation 401 errors', async () => {
    const signOut = vi.fn();
    const clear = setTrpcUnauthorizedHandler(signOut);
    const queryClient = createKiloAppQueryClient();
    const error = Object.assign(new Error('unauthorized'), {
      shape: { data: { httpStatus: 401 } },
    });

    const mutation = queryClient.getMutationCache().build(queryClient, {
      mutationFn: async () => {
        await Promise.resolve();
        throw error;
      },
    });

    await expect(mutation.execute(undefined)).rejects.toBe(error);
    expect(signOut).toHaveBeenCalledTimes(1);
    clear();
  });
});
