import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner-native';

import { useTRPC } from '@/lib/trpc';
import { asyncNoop } from '@/lib/utils';

const onMutationError = (error: { message: string }) => {
  toast.error(error.message || 'Something went wrong');
};

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

  const invalidateStatus = async () => {
    await queryClient.invalidateQueries({ queryKey: statusKey });
    await queryClient.invalidateQueries({ queryKey: controllerVersionKey });
  };

  const invalidateStatusAndPin = async () => {
    await invalidateStatus();
    await queryClient.invalidateQueries({ queryKey: pinKey });
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
      onSuccess: invalidateStatus,
      onError: onMutationError,
    }),
    updateModel: useMutation({
      ...dispatch(
        trpc.kiloclaw.updateKiloCodeConfig,
        trpc.organizations.kiloclaw.updateKiloCodeConfig
      ),
      ...optimistic(configKey, (old, input: Record<string, unknown>) => ({ ...old, ...input })),
    }),

    // Expose keys for screens that need manual invalidation (e.g., device-pairing)
    queryKeys: {
      pairingKey,
      devicePairingKey,
    },
  };
}
