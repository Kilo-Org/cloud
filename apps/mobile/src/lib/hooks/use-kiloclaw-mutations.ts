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
        onSuccess: invalidateStatus,
        onError: onMutationError,
      })
    ),
    setMyPin: useMutation(
      trpc.kiloclaw.setMyPin.mutationOptions({
        onSuccess: async () => {
          await invalidateStatus();
          await queryClient.invalidateQueries({
            queryKey: trpc.kiloclaw.getMyPin.queryKey(),
          });
        },
        onError: onMutationError,
      })
    ),
    removeMyPin: useMutation(
      trpc.kiloclaw.removeMyPin.mutationOptions({
        onSuccess: async () => {
          await invalidateStatus();
          await queryClient.invalidateQueries({
            queryKey: trpc.kiloclaw.getMyPin.queryKey(),
          });
        },
        onError: onMutationError,
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
        onSuccess: invalidateStatus,
        onError: onMutationError,
      })
    ),
    renameInstance: useMutation(
      trpc.kiloclaw.renameInstance.mutationOptions({
        onSuccess: invalidateStatus,
        onError: onMutationError,
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
        onSuccess: async () => {
          await queryClient.invalidateQueries({ queryKey: trpc.kiloclaw.getConfig.queryKey() });
        },
        onError: onMutationError,
      })
    ),
  };
}
