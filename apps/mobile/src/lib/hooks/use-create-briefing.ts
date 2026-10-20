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

export function useCreateBriefing(): CreateBriefingState {
  const trpc = useTRPC();
  const client = useQueryClient();
  const [prepared, setPrepared] = useState<PreparedBriefing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const revision = useRef(0);
  const busy = useRef(false);
  const mounted = useRef(true);
  const request = useRef<PrepareInput | null>(null);
  const currentPrepared = useRef<PreparedBriefing | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const onError = (failure: { message: string }) => {
    toast.error(failure.message);
    if (mounted.current) {
      setError(failure.message);
    }
  };
  const prepareMutation = useMutation(
    trpc.agentBriefing.prepareOneOff.mutationOptions({
      networkMode: 'always',
      retry: false,
      onError,
    })
  );
  const createMutation = useMutation(
    trpc.agentBriefing.createOneOff.mutationOptions({
      networkMode: 'always',
      retry: false,
      onError,
      onSuccess: report => {
        client.setQueryData(trpc.agentBriefing.get.queryKey({ reportId: report.id }), report);
        void client.invalidateQueries({ queryKey: trpc.agentBriefing.list.pathKey() });
      },
    })
  );

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
    if (busy.current || !online()) {
      return;
    }
    busy.current = true;
    const version = revision.current;
    request.current ??= { ...input, requestId: randomUUID() };
    currentPrepared.current = null;
    setPrepared(null);
    setError(null);
    try {
      const result = await prepareMutation.mutateAsync(request.current);
      if (mounted.current && revision.current === version) {
        currentPrepared.current = result;
        setPrepared(result);
      }
    } catch {
      // The mutation displays the failure; keep the request ID for a safe retry.
    } finally {
      busy.current = false;
    }
  };

  const create = async () => {
    const reviewed = currentPrepared.current;
    if (
      busy.current ||
      !reviewed ||
      !online() ||
      (reviewed.estimate && !reviewed.estimate.canGenerate)
    ) {
      return null;
    }
    busy.current = true;
    const version = revision.current;
    setError(null);
    try {
      const report = await createMutation.mutateAsync({
        reportId: reviewed.report.id,
        estimateToken: reviewed.estimate?.estimateToken ?? undefined,
      });
      return mounted.current && revision.current === version ? report : null;
    } catch {
      return null;
    } finally {
      busy.current = false;
    }
  };

  return {
    prepared,
    error,
    reset,
    prepare,
    create,
    preparing: prepareMutation.isPending,
    creating: createMutation.isPending,
  };
}
