import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner-native';

import { useAuth } from '@/lib/auth/auth-context';
import { useTRPC } from '@/lib/trpc';

export type DeleteAccountPhase = 'idle' | 'requesting' | 'awaiting-code' | 'executing' | 'deleted';

type DeleteAccountChallenge = { challengeId: string; devCode?: string };

/**
 * Derive the deletion flow phase from the mutation states. Order matters:
 * a completed delete wins over an in-flight one, and a held challenge wins
 * over a still-pending challenge request.
 */
function derivePhase(state: {
  isSuccess: boolean;
  isExecuting: boolean;
  hasChallenge: boolean;
  isRequesting: boolean;
}): DeleteAccountPhase {
  if (state.isSuccess) {
    return 'deleted';
  }
  if (state.isExecuting) {
    return 'executing';
  }
  if (state.hasChallenge) {
    return 'awaiting-code';
  }
  if (state.isRequesting) {
    return 'requesting';
  }
  return 'idle';
}

/**
 * Self-service account deletion, reauthenticated with an emailed sign-in code.
 *
 * `beginDelete` requests a confirmation-code challenge. On success the hook
 * moves to `awaiting-code`; the caller renders a code field and calls
 * `submitCode`. `submitCode` executes the deletion and, on success, signs the
 * user out. Any execute failure keeps the challenge so the caller can fix the
 * blocker (or correct the code) and resubmit the same `challengeId`.
 */
export function useDeleteAccount() {
  const trpc = useTRPC();
  const { signOut } = useAuth();

  const [challenge, setChallenge] = useState<DeleteAccountChallenge | null>(null);
  const codeRef = useRef('');

  const requestChallenge = useMutation(
    trpc.user.requestAccountDeletionChallenge.mutationOptions({
      onSuccess: data => {
        setChallenge(data);
        if (__DEV__ && data.devCode) {
          codeRef.current = data.devCode;
        }
      },
      onError: error => {
        toast.error(error.message);
      },
    })
  );

  const executeDeletion = useMutation(
    trpc.user.requestAccountDeletion.mutationOptions({
      onSuccess: () => {
        toast.success('Your account has been deleted.');
        void signOut(true);
      },
      onError: error => {
        toast.error(error.message);
      },
    })
  );

  const phase = derivePhase({
    isSuccess: executeDeletion.isSuccess,
    isExecuting: executeDeletion.isPending,
    hasChallenge: challenge !== null,
    isRequesting: requestChallenge.isPending,
  });

  const isPending = requestChallenge.isPending || executeDeletion.isPending;

  const beginDelete = () => {
    requestChallenge.mutate();
  };

  const submitCode = () => {
    if (!challenge) {
      return;
    }
    executeDeletion.mutate({ challengeId: challenge.challengeId, code: codeRef.current });
  };

  const setCode = (code: string) => {
    codeRef.current = code;
  };

  return {
    phase,
    isPending,
    devCode: challenge?.devCode ?? null,
    beginDelete,
    submitCode,
    setCode,
  };
}
