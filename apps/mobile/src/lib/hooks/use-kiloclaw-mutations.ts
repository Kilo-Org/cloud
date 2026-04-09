import { type QueryKey, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner-native';

import { useTRPC } from '@/lib/trpc';

const onMutationError = (error: { message: string }) => {
  toast.error(error.message || 'Something went wrong');
};

export function useKiloClawMutations() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const invalidateStatus = async () => {
    await queryClient.invalidateQueries({ queryKey: trpc.kiloclaw.getStatus.queryKey() });
    await queryClient.invalidateQueries({
      queryKey: trpc.kiloclaw.controllerVersion.queryKey(),
    });
  };

  function optimistic<TInput, TData extends Record<string, unknown>>(
    queryKey: QueryKey,
    updater: (old: TData, input: TInput) => TData,
    settle?: () => Promise<void>
  ) {
    return {
      onMutate: async (input: TInput) => {
        await queryClient.cancelQueries({ queryKey });
        const previous = queryClient.getQueryData<TData>(queryKey);
        queryClient.setQueryData<TData>(queryKey, old => (old ? updater(old, input) : old));
        return { previous };
      },
      onError: (error: { message: string }, _input: TInput, context?: { previous?: TData }) => {
        if (context?.previous) {
          queryClient.setQueryData(queryKey, context.previous);
        }
        onMutationError(error);
      },
      onSettled:
        settle ??
        (async () => {
          await queryClient.invalidateQueries({ queryKey });
        }),
    };
  }

  const statusKey = trpc.kiloclaw.getStatus.queryKey();
  const configKey = trpc.kiloclaw.getConfig.queryKey();
  const pinKey = trpc.kiloclaw.getMyPin.queryKey();

  const invalidateStatusAndPin = async () => {
    await invalidateStatus();
    await queryClient.invalidateQueries({ queryKey: pinKey });
  };

  return {
    start: useMutation(
      trpc.kiloclaw.start.mutationOptions({ onSuccess: invalidateStatus, onError: onMutationError })
    ),
    stop: useMutation(
      trpc.kiloclaw.stop.mutationOptions({ onSuccess: invalidateStatus, onError: onMutationError })
    ),
    restartMachine: useMutation(
      trpc.kiloclaw.restartMachine.mutationOptions({
        onSuccess: async () => {
          await invalidateStatus();
          await queryClient.invalidateQueries({
            queryKey: trpc.kiloclaw.gatewayStatus.queryKey(),
          });
        },
        onError: onMutationError,
      })
    ),
    restartOpenClaw: useMutation(
      trpc.kiloclaw.restartOpenClaw.mutationOptions({
        onSuccess: async () => {
          await invalidateStatus();
          await queryClient.invalidateQueries({
            queryKey: trpc.kiloclaw.gatewayStatus.queryKey(),
          });
        },
        onError: onMutationError,
      })
    ),
    patchSecrets: useMutation(
      trpc.kiloclaw.patchSecrets.mutationOptions({
        onSuccess: async () => {
          await invalidateStatus();
          await queryClient.invalidateQueries({ queryKey: configKey });
          // Small delay to let the worker process the secret before refetching catalog
          await new Promise<void>(resolve => {
            setTimeout(resolve, 1000);
          });
          await queryClient.invalidateQueries({
            queryKey: trpc.kiloclaw.getSecretCatalog.queryKey(),
          });
          await queryClient.invalidateQueries({
            queryKey: trpc.kiloclaw.getChannelCatalog.queryKey(),
          });
        },
        onError: onMutationError,
      })
    ),
    patchChannels: useMutation(
      trpc.kiloclaw.patchChannels.mutationOptions({
        onSuccess: async () => {
          await invalidateStatus();
          await queryClient.invalidateQueries({ queryKey: configKey });
          await new Promise<void>(resolve => {
            setTimeout(resolve, 1000);
          });
          await queryClient.invalidateQueries({
            queryKey: trpc.kiloclaw.getChannelCatalog.queryKey(),
          });
        },
        onError: onMutationError,
      })
    ),
    patchExecPreset: useMutation(
      trpc.kiloclaw.patchExecPreset.mutationOptions(
        optimistic(
          statusKey,
          (old, input) => ({
            ...old,
            ...(input.security != null && { execSecurity: input.security }),
            ...(input.ask != null && { execAsk: input.ask }),
          }),
          invalidateStatus
        )
      )
    ),
    setMyPin: useMutation(
      trpc.kiloclaw.setMyPin.mutationOptions({
        onMutate: async input => {
          await queryClient.cancelQueries({ queryKey: pinKey });
          const previous = queryClient.getQueryData(pinKey);
          if (previous) {
            queryClient.setQueryData(pinKey, {
              ...previous,
              image_tag: input.imageTag,
              openclaw_version: null,
              reason: input.reason ?? null,
              pinnedBySelf: true,
            });
          }
          return { previous };
        },
        onError: (error, _input, context) => {
          if (context?.previous !== undefined) {
            queryClient.setQueryData(pinKey, context.previous);
          }
          onMutationError(error);
        },
        onSettled: invalidateStatusAndPin,
      })
    ),
    removeMyPin: useMutation(
      trpc.kiloclaw.removeMyPin.mutationOptions({
        onMutate: async () => {
          await queryClient.cancelQueries({ queryKey: pinKey });
          const previous = queryClient.getQueryData(pinKey);
          queryClient.setQueryData(pinKey, null);
          return { previous };
        },
        onError: (error, _input, context) => {
          if (context?.previous !== undefined) {
            queryClient.setQueryData(pinKey, context.previous);
          }
          onMutationError(error);
        },
        onSettled: invalidateStatusAndPin,
      })
    ),
    approvePairingRequest: useMutation(
      trpc.kiloclaw.approvePairingRequest.mutationOptions({
        onSuccess: async () => {
          await queryClient.invalidateQueries({
            queryKey: trpc.kiloclaw.listPairingRequests.queryKey(),
          });
        },
        onError: onMutationError,
      })
    ),
    approveDevicePairingRequest: useMutation(
      trpc.kiloclaw.approveDevicePairingRequest.mutationOptions({
        onSuccess: async () => {
          await queryClient.invalidateQueries({
            queryKey: trpc.kiloclaw.listDevicePairingRequests.queryKey(),
          });
        },
        onError: onMutationError,
      })
    ),
    disconnectGoogle: useMutation(
      trpc.kiloclaw.disconnectGoogle.mutationOptions({
        onSuccess: invalidateStatus,
        onError: onMutationError,
      })
    ),
    setGmailNotifications: useMutation(
      trpc.kiloclaw.setGmailNotifications.mutationOptions(
        optimistic(
          statusKey,
          (old, input) => ({ ...old, gmailNotificationsEnabled: input.enabled }),
          invalidateStatus
        )
      )
    ),
    renameInstance: useMutation(
      trpc.kiloclaw.renameInstance.mutationOptions(
        optimistic(statusKey, (old, input) => ({ ...old, name: input.name }), invalidateStatus)
      )
    ),
    destroy: useMutation(
      trpc.kiloclaw.destroy.mutationOptions({
        onSuccess: invalidateStatus,
        onError: onMutationError,
      })
    ),
    updateModel: useMutation(
      trpc.kiloclaw.updateKiloCodeConfig.mutationOptions(
        optimistic(configKey, (old, input) => ({ ...old, ...input }))
      )
    ),
  };
}
