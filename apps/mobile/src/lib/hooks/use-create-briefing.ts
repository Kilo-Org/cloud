import {
  type inferRouterInputs,
  type inferRouterOutputs,
  type MobileRouter,
} from '@kilocode/trpc/mobile';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { randomUUID } from 'expo-crypto';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner-native';

import { i18n } from '@/i18n';
import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { isSignOutActive } from '@/lib/auth/sign-out-state';
import { getCommittedConnectivityStatus } from '@/lib/hooks/use-offline-banner-state';
import { useTRPC } from '@/lib/trpc';

type PrepareInput = inferRouterInputs<MobileRouter>['agentBriefing']['startOneOffPreparation'];
type Preparation = inferRouterOutputs<MobileRouter>['agentBriefing']['oneOffPreparation'];
export type PreparedBriefing = NonNullable<Preparation['prepared']>;
export type CreateBriefingState = {
  prepared: PreparedBriefing | null;
  draft: Preparation['draft'] | null;
  error: string | null;
  loading: boolean;
  reset: () => void;
  prepare: (input: Omit<PrepareInput, 'requestId'>) => Promise<Preparation['draft'] | null>;
  refresh: () => Promise<void>;
  retryPreparation: () => Promise<void>;
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

export function useCreateBriefing(reportId?: string): CreateBriefingState {
  const trpc = useTRPC();
  const client = useQueryClient();
  const [activeId, setActiveId] = useState<string | null>(reportId ?? null);
  const [prepared, setPrepared] = useState<PreparedBriefing | null>(null);
  const [errorMessage, setError] = useState<string | null>(null);
  const revision = useRef(0);
  const busy = useRef(false);
  const mounted = useRef(true);
  const selectionEpoch = useRef(currentAuthEpoch());
  const request = useRef<PrepareInput | null>(null);
  const currentPrepared = useRef<{ data: PreparedBriefing; epoch: number } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const onError = (key: 'agentBriefing.reviewFailed' | 'agentBriefing.createFailed') => {
    const message = i18n.t(key);
    toast.error(message);
    if (mounted.current) {
      setError(message);
    }
  };
  const preparationOptions = trpc.agentBriefing.oneOffPreparation.queryOptions({
    reportId: activeId ?? '',
  });
  const preparation = useQuery({
    ...preparationOptions,
    enabled: activeId !== null && isCurrentAuthEpoch(selectionEpoch.current) && !isSignOutActive(),
    retry: false,
    refetchInterval: query =>
      query.state.status !== 'error' &&
      ['pending', 'running'].includes(query.state.data?.draft.status ?? '')
        ? 2000
        : false,
    queryFn: context => {
      const epoch = selectionEpoch.current;
      assertCurrentOperation(epoch);
      if (!preparationOptions.queryFn) {
        throw new TypeError('Missing briefing preparation query');
      }
      return settleCurrentOperation(epoch, Promise.resolve(preparationOptions.queryFn(context)));
    },
  });
  useEffect(() => {
    if (!isCurrentAuthEpoch(selectionEpoch.current) || isSignOutActive()) {
      return;
    }
    if (preparation.isSuccess) {
      setError(null);
    }
    if (preparation.data?.prepared) {
      currentPrepared.current = { data: preparation.data.prepared, epoch: selectionEpoch.current };
      setPrepared(preparation.data.prepared);
    }
  }, [preparation.data, preparation.dataUpdatedAt, preparation.isSuccess]);
  useEffect(() => {
    if (preparation.error && isCurrentAuthEpoch(selectionEpoch.current) && !isSignOutActive()) {
      const message = i18n.t('agentBriefing.reviewFailed');
      setError(message);
      toast.error(message);
    }
  }, [preparation.error]);

  const prepareOptions = trpc.agentBriefing.startOneOffPreparation.mutationOptions({
    networkMode: 'always',
    retry: false,
  });
  const prepareMutation = useMutation({
    ...prepareOptions,
    mutationFn: (input, context) => {
      const epoch = operationEpochs.get(input);
      assertCurrentOperation(epoch);
      if (!prepareOptions.mutationFn) {
        throw new Error('Missing briefing preparation mutation');
      }
      return settleCurrentOperation(epoch, prepareOptions.mutationFn(input, context));
    },
  });
  const createOptions = trpc.agentBriefing.createOneOff.mutationOptions({
    networkMode: 'always',
    retry: false,
  });
  const createMutation = useMutation({
    ...createOptions,
    mutationFn: (input, context) => {
      const epoch = operationEpochs.get(input);
      assertCurrentOperation(epoch);
      if (!createOptions.mutationFn) {
        throw new Error('Missing briefing creation mutation');
      }
      return settleCurrentOperation(epoch, createOptions.mutationFn(input, context));
    },
  });

  const reset = () => {
    revision.current += 1;
    request.current = null;
    currentPrepared.current = null;
    setActiveId(null);
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
      return null;
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
      const draft = await prepareMutation.mutateAsync(request.current);
      if (
        mounted.current &&
        revision.current === version &&
        isCurrentAuthEpoch(epoch) &&
        !isSignOutActive()
      ) {
        selectionEpoch.current = epoch;
        setActiveId(draft.id);
        void client.invalidateQueries({ queryKey: trpc.agentBriefing.oneOffDrafts.pathKey() });
        return draft;
      }
    } catch {
      if (isCurrentAuthEpoch(epoch) && !isSignOutActive()) {
        onError('agentBriefing.reviewFailed');
      }
    } finally {
      busy.current = false;
    }
    return null;
  };
  const refresh = async () => {
    if (!online() || !isCurrentAuthEpoch(selectionEpoch.current) || isSignOutActive()) {
      return;
    }
    currentPrepared.current = null;
    setPrepared(null);
    setError(null);
    await preparation.refetch();
  };
  const retryPreparation = async () => {
    const draft = preparation.data?.draft;
    if (
      draft?.status !== 'failed' ||
      !isCurrentAuthEpoch(selectionEpoch.current) ||
      isSignOutActive()
    ) {
      return;
    }
    request.current = {
      requestId: draft.id,
      organizationId: draft.context.organizationId ?? undefined,
      startAt: draft.startAt,
      endAt: draft.endAt,
      timezone: draft.timezone,
      language: draft.language,
    };
    const result = await prepare(request.current);
    if (result) {
      await preparation.refetch();
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
      void client.invalidateQueries({ queryKey: trpc.agentBriefing.oneOffDrafts.pathKey() });
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
    draft: preparation.data?.draft ?? null,
    error: errorMessage,
    loading: activeId !== null && preparation.isPending,
    reset,
    prepare,
    refresh,
    retryPreparation,
    create,
    preparing:
      prepareMutation.isPending ||
      preparation.isFetching ||
      ['pending', 'running'].includes(preparation.data?.draft.status ?? ''),
    creating: createMutation.isPending,
  };
}
