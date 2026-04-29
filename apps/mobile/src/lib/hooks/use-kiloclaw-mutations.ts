/* eslint-disable max-lines */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner-native';

import { type ClawInstance } from '@/lib/hooks/use-instance-context';
import { useTRPC } from '@/lib/trpc';
import { asyncNoop } from '@/lib/utils';

const onMutationError = (error: { message: string }) => {
  toast.error(error.message || 'Something went wrong');
};

/**
 * Extract the tRPC `data.httpStatus` field without an `as` cast. Returns
 * `undefined` for any shape that doesn't match the tRPC error envelope.
 */
function getTrpcHttpStatus(error: unknown): number | undefined {
  if (error === null || typeof error !== 'object' || !('data' in error)) {
    return undefined;
  }
  const data = error.data;
  if (data === null || typeof data !== 'object' || !('httpStatus' in data)) {
    return undefined;
  }
  return typeof data.httpStatus === 'number' ? data.httpStatus : undefined;
}

/**
 * Retry policy for mutations we want to be resilient against transient
 * network blips and 5xx hiccups. Bails immediately on 4xx so permission or
 * validation errors surface without three rounds of backoff first.
 */
const retryTransient = (failureCount: number, error: unknown): boolean => {
  if (failureCount >= 3) {
    return false;
  }
  const httpStatus = getTrpcHttpStatus(error);
  if (httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500) {
    return false;
  }
  return true;
};

const retryTransientDelay = (attemptIndex: number): number =>
  Math.min(1000 * 2 ** attemptIndex, 10_000);

export function useKiloClawMutations(organizationId?: string | null) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const isResolved = organizationId !== undefined;
  const isOrg = Boolean(organizationId);
  const orgInput = { organizationId: organizationId ?? '' };

  const queryKey = (
    personal: { queryKey: () => unknown[] },
    org: { queryKey: (input: typeof orgInput) => unknown[] }
  ) => (isOrg ? org.queryKey(orgInput) : personal.queryKey());

  const statusKey = queryKey(trpc.kiloclaw.getStatus, trpc.organizations.kiloclaw.getStatus);
  const configKey = queryKey(trpc.kiloclaw.getConfig, trpc.organizations.kiloclaw.getConfig);
  const pinKey = queryKey(trpc.kiloclaw.getMyPin, trpc.organizations.kiloclaw.getMyPin);
  const controllerVersionKey = queryKey(
    trpc.kiloclaw.controllerVersion,
    trpc.organizations.kiloclaw.controllerVersion
  );
  const gatewayStatusKey = queryKey(
    trpc.kiloclaw.gatewayStatus,
    trpc.organizations.kiloclaw.gatewayStatus
  );
  const secretCatalogKey = queryKey(
    trpc.kiloclaw.getSecretCatalog,
    trpc.organizations.kiloclaw.getSecretCatalog
  );
  const channelCatalogKey = queryKey(
    trpc.kiloclaw.getChannelCatalog,
    trpc.organizations.kiloclaw.getChannelCatalog
  );
  const pairingKey = queryKey(
    trpc.kiloclaw.listPairingRequests,
    trpc.organizations.kiloclaw.listPairingRequests
  );
  const devicePairingKey = queryKey(
    trpc.kiloclaw.listDevicePairingRequests,
    trpc.organizations.kiloclaw.listDevicePairingRequests
  );

  const listAllInstancesKey = trpc.kiloclaw.listAllInstances.queryKey();
  const billingStatusKey = trpc.kiloclaw.getBillingStatus.queryKey();

  const invalidateStatus = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: statusKey }),
      queryClient.invalidateQueries({ queryKey: controllerVersionKey }),
    ]);
  };

  const invalidateStatusAndPin = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: statusKey }),
      queryClient.invalidateQueries({ queryKey: controllerVersionKey }),
      queryClient.invalidateQueries({ queryKey: pinKey }),
    ]);
  };

  // `billingStatusKey` is included because the mobile onboarding state is
  // derived client-side from `getBillingStatus` (see
  // `lib/derive-mobile-onboarding-state.ts`). Invalidating billing is what
  // actually refreshes the onboarding facade.
  const invalidateProvisioned = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: listAllInstancesKey }),
      queryClient.invalidateQueries({ queryKey: statusKey }),
      queryClient.invalidateQueries({ queryKey: gatewayStatusKey }),
      queryClient.invalidateQueries({ queryKey: billingStatusKey }),
    ]);
  };

  function optimistic<TInput, TData extends Record<string, unknown>>(
    key: unknown[],
    updater: (old: TData, input: TInput) => TData,
    settle?: () => Promise<void>
  ) {
    return {
      onMutate: async (input: TInput) => {
        await queryClient.cancelQueries({ queryKey: key });
        const previous = queryClient.getQueryData<TData>(key);
        queryClient.setQueryData<TData>(key, old => (old ? updater(old, input) : old));
        return { previous };
      },
      onError: (error: { message: string }, _input: TInput, context?: { previous?: TData }) => {
        if (context?.previous) {
          queryClient.setQueryData(key, context.previous);
        }
        onMutationError(error);
      },
      onSettled:
        settle ??
        (async () => {
          await queryClient.invalidateQueries({ queryKey: key });
        }),
    };
  }

  // Extracts mutationFn from personal or org path and injects organizationId
  type AnyMutPath = {
    mutationOptions: (opts: object) => {
      // eslint-disable-next-line typescript-eslint/no-explicit-any -- wrapping arbitrary tRPC mutations
      mutationFn?: ((...args: any[]) => Promise<unknown>) | undefined;
      mutationKey: unknown[];
    };
  };

  function dispatch(personal: AnyMutPath, org: AnyMutPath) {
    const personalOpts = personal.mutationOptions({});
    const orgOpts = org.mutationOptions({});
    const personalFn = personalOpts.mutationFn ?? asyncNoop;
    const orgFn = orgOpts.mutationFn ?? asyncNoop;

    let mutationFn: (...args: unknown[]) => Promise<unknown> = asyncNoop;
    if (isResolved && isOrg) {
      // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
      mutationFn = (input: unknown) =>
        orgFn(
          input && typeof input === 'object' ? { ...input, organizationId } : { organizationId }
        );
    } else if (isResolved) {
      mutationFn = personalFn;
    }

    return {
      mutationKey: isOrg ? orgOpts.mutationKey : personalOpts.mutationKey,
      mutationFn,
    };
  }

  // ── Mutations ───────────────────────────────────────────────────

  return {
    start: useMutation({
      ...dispatch(trpc.kiloclaw.start, trpc.organizations.kiloclaw.start),
      onSuccess: invalidateStatus,
      onError: onMutationError,
    }),
    stop: useMutation({
      ...dispatch(trpc.kiloclaw.stop, trpc.organizations.kiloclaw.stop),
      onSuccess: invalidateStatus,
      onError: onMutationError,
    }),
    restartMachine: useMutation({
      ...dispatch(trpc.kiloclaw.restartMachine, trpc.organizations.kiloclaw.restartMachine),
      onSuccess: async () => {
        await invalidateStatus();
        await queryClient.invalidateQueries({ queryKey: gatewayStatusKey });
      },
      onError: onMutationError,
    }),
    restartOpenClaw: useMutation({
      ...dispatch(trpc.kiloclaw.restartOpenClaw, trpc.organizations.kiloclaw.restartOpenClaw),
      onSuccess: async () => {
        await invalidateStatus();
        await queryClient.invalidateQueries({ queryKey: gatewayStatusKey });
      },
      onError: onMutationError,
    }),
    patchSecrets: useMutation({
      ...dispatch(trpc.kiloclaw.patchSecrets, trpc.organizations.kiloclaw.patchSecrets),
      onSuccess: async () => {
        await invalidateStatus();
        await queryClient.invalidateQueries({ queryKey: configKey });
        await new Promise<void>(resolve => {
          setTimeout(resolve, 1000);
        });
        await queryClient.invalidateQueries({ queryKey: secretCatalogKey });
        await queryClient.invalidateQueries({ queryKey: channelCatalogKey });
      },
      onError: onMutationError,
    }),
    patchChannels: useMutation({
      ...dispatch(trpc.kiloclaw.patchChannels, trpc.organizations.kiloclaw.patchChannels),
      onSuccess: async () => {
        await invalidateStatus();
        await queryClient.invalidateQueries({ queryKey: configKey });
        await new Promise<void>(resolve => {
          setTimeout(resolve, 1000);
        });
        await queryClient.invalidateQueries({ queryKey: channelCatalogKey });
      },
      onError: onMutationError,
    }),
    patchBotIdentity: useMutation({
      ...dispatch(trpc.kiloclaw.patchBotIdentity, trpc.organizations.kiloclaw.patchBotIdentity),
      onSuccess: async () => {
        await invalidateStatus();
        await queryClient.invalidateQueries({ queryKey: configKey });
      },
      onError: onMutationError,
      retry: retryTransient,
      retryDelay: retryTransientDelay,
      // Serialize concurrent writes to the same bot identity so a re-submission
      // (e.g. user tapped back on onboarding, changed the name, re-submitted
      // while the first mutation was mid-retry) always lands at the DO after
      // the first call completes. Guarantees last-write-wins without manual
      // AbortController plumbing.
      scope: { id: `kiloclaw-patch-bot-identity:${organizationId ?? 'personal'}` },
    }),
    patchOpenclawConfig: useMutation({
      ...dispatch(
        trpc.kiloclaw.patchOpenclawConfig,
        trpc.organizations.kiloclaw.patchOpenclawConfig
      ),
      onSuccess: async () => {
        await invalidateStatus();
        await queryClient.invalidateQueries({ queryKey: configKey });
      },
      onError: onMutationError,
    }),
    patchExecPreset: useMutation({
      ...dispatch(trpc.kiloclaw.patchExecPreset, trpc.organizations.kiloclaw.patchExecPreset),
      ...optimistic(
        statusKey,
        (old, input: { security?: string; ask?: string }) => ({
          ...old,
          ...(input.security != null && { execSecurity: input.security }),
          ...(input.ask != null && { execAsk: input.ask }),
        }),
        invalidateStatus
      ),
      retry: retryTransient,
      retryDelay: retryTransientDelay,
      // Serialize concurrent exec-preset writes (see patchBotIdentity note).
      scope: { id: `kiloclaw-patch-exec-preset:${organizationId ?? 'personal'}` },
    }),
    setMyPin: useMutation({
      ...dispatch(trpc.kiloclaw.setMyPin, trpc.organizations.kiloclaw.setMyPin),
      onMutate: async (input: { imageTag: string; reason?: string }) => {
        await queryClient.cancelQueries({ queryKey: pinKey });
        const previous = queryClient.getQueryData<Record<string, unknown>>(pinKey);
        if (previous) {
          queryClient.setQueryData<Record<string, unknown>>(pinKey, {
            ...previous,
            image_tag: input.imageTag,
            openclaw_version: null,
            reason: input.reason ?? null,
            pinnedBySelf: true,
          });
        }
        return { previous };
      },
      onError: (
        error: { message: string },
        _input: { imageTag: string; reason?: string },
        context?: { previous?: Record<string, unknown> }
      ) => {
        if (context?.previous !== undefined) {
          queryClient.setQueryData<Record<string, unknown>>(pinKey, context.previous);
        }
        onMutationError(error);
      },
      onSettled: invalidateStatusAndPin,
    }),
    removeMyPin: useMutation({
      ...dispatch(trpc.kiloclaw.removeMyPin, trpc.organizations.kiloclaw.removeMyPin),
      onMutate: async () => {
        await queryClient.cancelQueries({ queryKey: pinKey });
        const previous = queryClient.getQueryData<Record<string, unknown> | null>(pinKey);
        queryClient.setQueryData<Record<string, unknown> | null>(pinKey, null);
        return { previous };
      },
      onError: (
        error: { message: string },
        _input: unknown,
        context?: { previous?: Record<string, unknown> | null }
      ) => {
        if (context?.previous !== undefined) {
          queryClient.setQueryData<Record<string, unknown> | null>(pinKey, context.previous);
        }
        onMutationError(error);
      },
      onSettled: invalidateStatusAndPin,
    }),
    approvePairingRequest: useMutation({
      ...dispatch(
        trpc.kiloclaw.approvePairingRequest,
        trpc.organizations.kiloclaw.approvePairingRequest
      ),
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: pairingKey });
      },
      onError: onMutationError,
    }),
    approveDevicePairingRequest: useMutation({
      ...dispatch(
        trpc.kiloclaw.approveDevicePairingRequest,
        trpc.organizations.kiloclaw.approveDevicePairingRequest
      ),
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: devicePairingKey });
      },
      onError: onMutationError,
    }),
    disconnectGoogle: useMutation({
      ...dispatch(trpc.kiloclaw.disconnectGoogle, trpc.organizations.kiloclaw.disconnectGoogle),
      onSuccess: invalidateStatus,
      onError: onMutationError,
    }),
    setGmailNotifications: useMutation({
      ...dispatch(
        trpc.kiloclaw.setGmailNotifications,
        trpc.organizations.kiloclaw.setGmailNotifications
      ),
      ...optimistic(
        statusKey,
        (old, input: { enabled: boolean }) => ({
          ...old,
          gmailNotificationsEnabled: input.enabled,
        }),
        invalidateStatus
      ),
    }),
    renameInstance: useMutation({
      ...dispatch(trpc.kiloclaw.renameInstance, trpc.organizations.kiloclaw.renameInstance),
      ...optimistic(
        statusKey,
        (old, input: { name: string | null }) => ({ ...old, name: input.name }),
        invalidateStatus
      ),
    }),
    destroy: useMutation({
      ...dispatch(trpc.kiloclaw.destroy, trpc.organizations.kiloclaw.destroy),
      // Optimistically remove this context's row from the list cache so
      // Home reflects the destruction immediately. A race between focus
      // refetch and the server marking `destroyed_at` would otherwise
      // re-surface the destroyed row briefly.
      onMutate: async () => {
        await queryClient.cancelQueries({ queryKey: listAllInstancesKey });
        const previous = queryClient.getQueryData<ClawInstance[]>(listAllInstancesKey);
        const contextOrgId = organizationId ?? null;
        queryClient.setQueryData<ClawInstance[]>(listAllInstancesKey, old =>
          old ? old.filter(row => (row.organizationId ?? null) !== contextOrgId) : old
        );
        return { previous };
      },
      onError: (error, _input, context) => {
        if (context?.previous) {
          queryClient.setQueryData(listAllInstancesKey, context.previous);
        }
        onMutationError(error);
      },
      onSettled: async () => {
        await Promise.all([
          invalidateStatus(),
          queryClient.invalidateQueries({ queryKey: listAllInstancesKey }),
        ]);
      },
    }),
    updateModel: useMutation({
      ...dispatch(
        trpc.kiloclaw.updateKiloCodeConfig,
        trpc.organizations.kiloclaw.updateKiloCodeConfig
      ),
      ...optimistic(configKey, (old, input: Record<string, unknown>) => ({ ...old, ...input })),
    }),
    // Errors are categorized at the onboarding screen (locked/billing conflict,
    // quarantined, generic). The screen's callsite `onError` owns user-visible
    // feedback and falls back to `toast.error` for the generic case.
    provision: useMutation(
      trpc.kiloclaw.provision.mutationOptions({
        onSuccess: invalidateProvisioned,
      })
    ),

    // Expose keys for screens that need manual invalidation (e.g., device-pairing)
    queryKeys: {
      pairingKey,
      devicePairingKey,
    },
  };
}
