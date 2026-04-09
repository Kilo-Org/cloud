import { useMutation, useQueryClient } from '@tanstack/react-query';
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
          await queryClient.invalidateQueries({ queryKey: trpc.kiloclaw.getConfig.queryKey() });
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
          await queryClient.invalidateQueries({ queryKey: trpc.kiloclaw.getConfig.queryKey() });
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
      trpc.kiloclaw.patchExecPreset.mutationOptions({
        onMutate: async input => {
          await queryClient.cancelQueries({ queryKey: trpc.kiloclaw.getStatus.queryKey() });
          const previous = queryClient.getQueryData(trpc.kiloclaw.getStatus.queryKey());
          queryClient.setQueryData(trpc.kiloclaw.getStatus.queryKey(), (old: typeof previous) => {
            if (!old) {
              return old;
            }
            return {
              ...old,
              ...(input.security != null && { execSecurity: input.security }),
              ...(input.ask != null && { execAsk: input.ask }),
            };
          });
          return { previous };
        },
        onError: (error, _input, context) => {
          if (context?.previous) {
            queryClient.setQueryData(trpc.kiloclaw.getStatus.queryKey(), context.previous);
          }
          onMutationError(error);
        },
        onSettled: invalidateStatus,
      })
    ),
    setMyPin: useMutation(
      trpc.kiloclaw.setMyPin.mutationOptions({
        onMutate: async input => {
          await queryClient.cancelQueries({ queryKey: trpc.kiloclaw.getMyPin.queryKey() });
          const previous = queryClient.getQueryData(trpc.kiloclaw.getMyPin.queryKey());
          if (previous) {
            queryClient.setQueryData(trpc.kiloclaw.getMyPin.queryKey(), {
              ...previous,
              image_tag: input.imageTag,
              reason: input.reason ?? null,
              pinnedBySelf: true,
            });
          }
          return { previous };
        },
        onError: (error, _input, context) => {
          if (context?.previous !== undefined) {
            queryClient.setQueryData(trpc.kiloclaw.getMyPin.queryKey(), context.previous);
          }
          onMutationError(error);
        },
        onSettled: async () => {
          await invalidateStatus();
          await queryClient.invalidateQueries({
            queryKey: trpc.kiloclaw.getMyPin.queryKey(),
          });
        },
      })
    ),
    removeMyPin: useMutation(
      trpc.kiloclaw.removeMyPin.mutationOptions({
        onMutate: async () => {
          await queryClient.cancelQueries({ queryKey: trpc.kiloclaw.getMyPin.queryKey() });
          const previous = queryClient.getQueryData(trpc.kiloclaw.getMyPin.queryKey());
          queryClient.setQueryData(trpc.kiloclaw.getMyPin.queryKey(), null);
          return { previous };
        },
        onError: (error, _input, context) => {
          if (context?.previous !== undefined) {
            queryClient.setQueryData(trpc.kiloclaw.getMyPin.queryKey(), context.previous);
          }
          onMutationError(error);
        },
        onSettled: async () => {
          await invalidateStatus();
          await queryClient.invalidateQueries({
            queryKey: trpc.kiloclaw.getMyPin.queryKey(),
          });
        },
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
      trpc.kiloclaw.setGmailNotifications.mutationOptions({
        onMutate: async input => {
          await queryClient.cancelQueries({ queryKey: trpc.kiloclaw.getStatus.queryKey() });
          const previous = queryClient.getQueryData(trpc.kiloclaw.getStatus.queryKey());
          queryClient.setQueryData(trpc.kiloclaw.getStatus.queryKey(), (old: typeof previous) =>
            old ? { ...old, gmailNotificationsEnabled: input.enabled } : old
          );
          return { previous };
        },
        onError: (error, _input, context) => {
          if (context?.previous) {
            queryClient.setQueryData(trpc.kiloclaw.getStatus.queryKey(), context.previous);
          }
          onMutationError(error);
        },
        onSettled: invalidateStatus,
      })
    ),
    renameInstance: useMutation(
      trpc.kiloclaw.renameInstance.mutationOptions({
        onMutate: async input => {
          await queryClient.cancelQueries({ queryKey: trpc.kiloclaw.getStatus.queryKey() });
          const previous = queryClient.getQueryData(trpc.kiloclaw.getStatus.queryKey());
          queryClient.setQueryData(trpc.kiloclaw.getStatus.queryKey(), (old: typeof previous) =>
            old ? { ...old, name: input.name } : old
          );
          return { previous };
        },
        onError: (error, _input, context) => {
          if (context?.previous) {
            queryClient.setQueryData(trpc.kiloclaw.getStatus.queryKey(), context.previous);
          }
          onMutationError(error);
        },
        onSettled: invalidateStatus,
      })
    ),
    destroy: useMutation(
      trpc.kiloclaw.destroy.mutationOptions({
        onSuccess: invalidateStatus,
        onError: onMutationError,
      })
    ),
    updateModel: useMutation(
      trpc.kiloclaw.updateKiloCodeConfig.mutationOptions({
        onMutate: async input => {
          await queryClient.cancelQueries({ queryKey: trpc.kiloclaw.getConfig.queryKey() });
          const previous = queryClient.getQueryData(trpc.kiloclaw.getConfig.queryKey());
          queryClient.setQueryData(trpc.kiloclaw.getConfig.queryKey(), (old: typeof previous) =>
            old ? { ...old, ...input } : old
          );
          return { previous };
        },
        onError: (error, _input, context) => {
          if (context?.previous) {
            queryClient.setQueryData(trpc.kiloclaw.getConfig.queryKey(), context.previous);
          }
          onMutationError(error);
        },
        onSettled: async () => {
          await queryClient.invalidateQueries({ queryKey: trpc.kiloclaw.getConfig.queryKey() });
        },
      })
    ),
  };
}
