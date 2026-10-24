import {
  type inferRouterInputs,
  type inferRouterOutputs,
  type MobileRouter,
} from '@kilocode/trpc/mobile';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner-native';

import { i18n } from '@/i18n';
import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { isSignOutActive } from '@/lib/auth/sign-out-state';
import { getCommittedConnectivityStatus } from '@/lib/hooks/use-offline-banner-state';
import { useTRPC } from '@/lib/trpc';

type PrepareInput = inferRouterInputs<MobileRouter>['agentBriefing']['prepareOneOff'];
export type PreparedBriefing = inferRouterOutputs<MobileRouter>['agentBriefing']['prepareOneOff'];
export type CreateBriefingState = {
  prepared: PreparedBriefing | null;
  error: string | null;
  reset: () => void;
  prepare: (input: Omit<PrepareInput, 'requestId'>) => Promise<void>;
  create: () => Promise<PreparedBriefing['report'] | null>;
  preparing: boolean;
  creating: boolean;
};

const operationEpochs = new WeakMap<object, number>();

function assertCurrentOperation(epoch: number | undefined): asserts epoch is number {
  if (epoch === undefined || !isCurrentAuthEpoch(epoch) || isSignOutActive()) {
    throw new Error('Briefing operation belongs to an inactive account');
  }
}

async function settleCurrentOperation<T>(epoch: number, operation: Promise<T>): Promise<T> {
  try {
    const result = await operation;
    assertCurrentOperation(epoch);
    return result;
  } catch (error) {
    assertCurrentOperation(epoch);
    throw error;
  }
}

export function useCreateBriefing(): CreateBriefingState {
  const trpc = useTRPC();
  const client = useQueryClient();
  const [prepared, setPrepared] = useState<PreparedBriefing | null>(null);
  const [errorMessage, setError] = useState<string | null>(null);
  const revision = useRef(0);
  const busy = useRef(false);
  const mounted = useRef(true);
  const request = useRef<PrepareInput | null>(null);
  const currentPrepared = useRef<{ data: PreparedBriefing; epoch: number } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // A backend failure sentence is written by the server in one language, so the
  // screen never renders it. Known reasons arrive as structured data (the
  // estimate) and are already localized; anything else gets one localized line
  // and the raw message stays out of the UI.
  const onError = (key: 'agentBriefing.reviewFailed' | 'agentBriefing.createFailed') => {
    const message = i18n.t(key);
    toast.error(message);
    if (mounted.current) {
      setError(message);
    }
  };
  const prepareOptions = trpc.agentBriefing.prepareOneOff.mutationOptions({
    networkMode: 'always',
    retry: false,
  });
  const prepareMutation = useMutation({
    ...prepareOptions,
    mutationFn: async (input, context) => {
      const epoch = operationEpochs.get(input);
      assertCurrentOperation(epoch);
      if (!prepareOptions.mutationFn) {
        throw new Error('Missing briefing preparation mutation');
      }
      const result = await settleCurrentOperation(epoch, prepareOptions.mutationFn(input, context));
      return result;
    },
  });
  const createOptions = trpc.agentBriefing.createOneOff.mutationOptions({
    networkMode: 'always',
    retry: false,
  });
  const createMutation = useMutation({
    ...createOptions,
    mutationFn: async (input, context) => {
      const epoch = operationEpochs.get(input);
      assertCurrentOperation(epoch);
      if (!createOptions.mutationFn) {
        throw new Error('Missing briefing creation mutation');
      }
      const result = await settleCurrentOperation(epoch, createOptions.mutationFn(input, context));
      return result;
    },
  });

  const reset = () => {
    revision.current += 1;
    request.current = null;
    currentPrepared.current = null;
    setPrepared(null);
    setError(null);
  };
  const online = () => {
    if (getCommittedConnectivityStatus() !== 'offline') {
      return true;
    }
    const message = i18n.t('agentBriefing.createOffline');
    setError(message);
    toast.error(message);
    return false;
  };

  const prepare = async (input: Omit<PrepareInput, 'requestId'>) => {
    if (busy.current || isSignOutActive() || !online()) {
      return;
    }
    busy.current = true;
    const version = revision.current;
    const epoch = currentAuthEpoch();
    request.current ??= { ...input, requestId: randomUUID() };
    operationEpochs.set(request.current, epoch);
    currentPrepared.current = null;
    setPrepared(null);
    setError(null);
    try {
      const result = await prepareMutation.mutateAsync(request.current);
      if (
        mounted.current &&
        revision.current === version &&
        isCurrentAuthEpoch(epoch) &&
        !isSignOutActive()
      ) {
        currentPrepared.current = { data: result, epoch };
        setPrepared(result);
      }
    } catch {
      if (isCurrentAuthEpoch(epoch) && !isSignOutActive()) {
        onError('agentBriefing.reviewFailed');
      }
    } finally {
      busy.current = false;
    }
  };

  const create = async () => {
    const reviewed = currentPrepared.current;
    if (
      busy.current ||
      !reviewed ||
      !isCurrentAuthEpoch(reviewed.epoch) ||
      isSignOutActive() ||
      !online() ||
      (reviewed.data.estimate && !reviewed.data.estimate.canGenerate)
    ) {
      return null;
    }
    busy.current = true;
    const version = revision.current;
    const epoch = reviewed.epoch;
    setError(null);
    try {
      const input = {
        reportId: reviewed.data.report.id,
        estimateToken: reviewed.data.estimate?.estimateToken ?? undefined,
      };
      operationEpochs.set(input, epoch);
      const report = await createMutation.mutateAsync(input);
      if (!isCurrentAuthEpoch(epoch) || isSignOutActive()) {
        return null;
      }
      client.setQueryData(trpc.agentBriefing.get.queryKey({ reportId: report.id }), report);
      void client.invalidateQueries({ queryKey: trpc.agentBriefing.list.pathKey() });
      return mounted.current && revision.current === version ? report : null;
    } catch {
      if (isCurrentAuthEpoch(epoch) && !isSignOutActive()) {
        onError('agentBriefing.createFailed');
      }
      return null;
    } finally {
      busy.current = false;
    }
  };

  return {
    prepared,
    error: errorMessage,
    reset,
    prepare,
    create,
    preparing: prepareMutation.isPending,
    creating: createMutation.isPending,
  };
}
