import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner-native';

import { useTRPC } from '@/lib/trpc';

const onError = (error: { message: string }) => {
  toast.error(error.message || 'Something went wrong');
};

export function useSessionMutations() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const invalidateSessions = async () => {
    await Promise.all([
      queryClient.invalidateQueries(trpc.cliSessionsV2.list.pathFilter()),
      queryClient.invalidateQueries(trpc.cliSessionsV2.recentRepositories.pathFilter()),
    ]);
  };

  const deleteSessionMutation = useMutation(
    trpc.cliSessionsV2.delete.mutationOptions({
      onSuccess: invalidateSessions,
      onError,
    })
  );

  const renameSessionMutation = useMutation(
    trpc.cliSessionsV2.rename.mutationOptions({
      onSuccess: invalidateSessions,
      onError,
    })
  );

  return {
    deleteSession: (sessionId: string) => {
      deleteSessionMutation.mutate({ session_id: sessionId });
    },
    renameSession: (sessionId: string, title: string) => {
      renameSessionMutation.mutate({ session_id: sessionId, title });
    },
  };
}
