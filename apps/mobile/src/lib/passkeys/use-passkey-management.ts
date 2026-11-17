/* eslint-disable max-lines -- one hook owns the fresh-proof sequence for all three operations, its single-flight guard, and the guards that keep a late answer off another account */
import { hashKey, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner-native';

import { passkeysSupported, registerPasskey } from '@/lib/auth/passkey-client';
import {
  isLatestMutationGeneration,
  nextMutationGeneration,
} from '@/lib/hooks/mutation-generations';
import { type AddFailure } from '@/lib/passkeys/add-failure-notice';
import { type PasskeyRow, type PasskeysResult } from '@/lib/passkeys/passkey-types';
import { type PasskeyVerification } from '@/lib/passkeys/passkey-verification-state';
import { usePasskeyVerification } from '@/lib/passkeys/use-passkey-verification';
import { useTRPC } from '@/lib/trpc';
import { readTrpcErrorField } from '@/lib/trpc-error';

export type PasskeyManagement = {
  /** The fresh-proof panel's state and controls; the screen renders it. */
  verification: PasskeyVerification;
  verifying: boolean;
  isAdding: boolean;
  addFailure: AddFailure | null;
  canCreatePasskeys: boolean;
  /** The passkey whose removal failed and can be retried, if its row still exists. */
  removeFailureId: string | null;
  /** True while the delete that `removeFailureId` names is in flight. */
  removalInFlight: boolean;
  /** True while any removal is in flight; the rows' controls wait for it. */
  removing: boolean;
  handleAddPasskey: () => void;
  handleRemovePasskey: (id: string) => void;
  handleRetryRemove: () => void;
  handleRenamePasskey: (passkey: PasskeyRow, name: string) => void;
};

/**
 * The identity one mutation belongs to. React Query hands it to every callback
 * of that mutation, so a late answer can tell whether it still speaks for the
 * account and operation on screen.
 */
type MutationGuard = { accountId: string | undefined; operation: number };

/**
 * The management refusal a tRPC call was answered with, if any. The procedures
 * name it as the error message: a call without fresh proof, one whose
 * authorization expired or was already spent, and one whose credential can
 * never mint an authorization at all.
 */
function managementRefusal(error: unknown): 'required' | 'invalid' | 'device' | null {
  switch (readTrpcErrorField(error, 'message')) {
    case undefined: {
      return null;
    }
    case 'PASSKEY_MANAGEMENT_REQUIRED': {
      return 'required';
    }
    case 'PASSKEY_MANAGEMENT_AUTHORIZATION_INVALID': {
      return 'invalid';
    }
    case 'PASSKEY_MANAGEMENT_DEVICE_UNSUPPORTED': {
      return 'device';
    }
    default: {
      return null;
    }
  }
}

/**
 * Add, rename and remove passkeys from the app, each behind fresh primary proof
 * given in the app.
 *
 * A native bearer alone cannot manage a credential: the server wants a
 * management authorization minted from a passkey assertion or a code sent to
 * the account's own address, and that authorization is single-use and bound to
 * one operation. This hook owns that sequence for all three operations —
 * request the proof, hand the minted authorization to exactly the operation
 * that asked for it, and answer a refusal the only way it can be answered:
 * verify again, or say plainly that this sign-in can never manage passkeys.
 *
 * The mutations stay optimistic exactly where they were: a removal drops its
 * row first and restores it from the snapshot on failure, while every answer
 * that could belong to a previous account is dropped instead of reported.
 */
export function usePasskeyManagement(options: {
  accountId: string | undefined;
  email: string | undefined;
  passkeys: PasskeyRow[];
  /** Re-read the list after a write the server accepted. */
  onListChanged: () => void;
}): PasskeyManagement {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const listKey = trpc.user.getPasskeys.queryKey();
  // Stable per-cache key for the removal generations: overlapping removals must
  // not let an older failure's snapshot overwrite a newer one's state.
  const removalKey = hashKey(listKey);

  const [addFailure, setAddFailure] = useState<AddFailure | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [failedRemoveId, setFailedRemoveId] = useState<string | null>(null);

  const verification = usePasskeyVerification({
    accountId: options.accountId,
    email: options.email,
    hasPasskey: options.passkeys.length > 0,
  });
  const verifying = verification.state.phase !== 'closed';

  // Every completion is checked against the account the screen is showing and
  // the operation that asked for it: an answer for an account that has signed
  // out, or for a superseded operation, must not toast, write the cache or
  // refetch over the next one.
  const accountRef = useRef<string | undefined>(options.accountId);
  accountRef.current = options.accountId;
  const operationRef = useRef(0);
  /** Stamp one operation; only its own callbacks may act afterwards. */
  const beginGuard = (): MutationGuard => {
    const operation = operationRef.current + 1;
    operationRef.current = operation;
    return { accountId: accountRef.current, operation };
  };
  const guardHolds = (context: MutationGuard | undefined) =>
    context !== undefined &&
    context.accountId === accountRef.current &&
    context.operation === operationRef.current;
  const isCurrentAccount = (startedFor: string | undefined) => startedFor === accountRef.current;

  const remove = useMutation(
    trpc.user.deletePasskey.mutationOptions({
      onMutate: async ({ id }) => {
        const guard = beginGuard();
        await queryClient.cancelQueries({ queryKey: listKey });
        const generation = nextMutationGeneration(removalKey);
        const previous = queryClient.getQueryData<PasskeysResult>(listKey);
        queryClient.setQueryData<PasskeysResult>(listKey, old =>
          old ? { ...old, passkeys: old.passkeys.filter(passkey => passkey.id !== id) } : old
        );
        return { previous, generation, ...guard };
      },
      onError: (error, { id }, context) => {
        if (!guardHolds(context)) {
          return;
        }
        // Only the newest removal owns the cache: an older failure's snapshot
        // predates a newer removal's optimistic write, so replaying it would
        // resurrect the row the newer removal already took over. The newer
        // write reconciles with the server at settle.
        if (context && isLatestMutationGeneration(removalKey, context.generation)) {
          queryClient.setQueryData(listKey, context.previous);
          setFailedRemoveId(id);
        }
        // A management refusal is answered by the verification panel, in the
        // app; its server code is not copy the person can act on.
        if (managementRefusal(error) === null) {
          toast.error(error.message);
        }
      },
      onSuccess: (_result, { id }, context) => {
        if (!guardHolds(context)) {
          return;
        }
        if (isLatestMutationGeneration(removalKey, context.generation)) {
          setFailedRemoveId(current => (current === id ? null : current));
        }
        toast.success(t('profile.passkeyRemoved'));
      },
      // Reconcile with the server either way, so a rollback cannot leave a row
      // the server does not have or hide one it does.
      // eslint-disable-next-line max-params -- React Query passes the settled result, error, variables and context
      onSettled: (_result, _error, _variables, context) => {
        if (guardHolds(context)) {
          options.onListChanged();
        }
      },
    })
  );

  const rename = useMutation(
    trpc.user.renamePasskey.mutationOptions({
      onMutate: () => beginGuard(),
      onSuccess: (_result, _variables, context) => {
        if (!guardHolds(context)) {
          return;
        }
        toast.success(t('profile.passkeyRenamed'));
        options.onListChanged();
      },
      // A failed rename must reach the user even if the modal is dismissed,
      // so the hook reports it (apps/mobile/AGENTS.md). A management refusal is
      // answered by the verification panel instead.
      onError: (error, _variables, context) => {
        if (!guardHolds(context)) {
          return;
        }
        if (managementRefusal(error) === null) {
          toast.error(error.message);
        }
      },
    })
  );

  /**
   * Answer a refusal whose only fix is another proof. An expired or already
   * spent authorization needs a new one; one the server says this sign-in can
   * never mint is not fixable from here, so it is said instead.
   */
  const reopenVerification = (
    operation: 'enroll' | 'rename' | 'remove',
    retry: (authorization: string) => void,
    refusal: 'required' | 'invalid' | 'device'
  ) => {
    if (refusal === 'device') {
      setAddFailure('device-unsupported');
      toast.error(t('profile.passkeyManagementUnavailable'));
      return;
    }
    verification.open(
      operation,
      retry,
      refusal === 'invalid' ? 'profile.passkeyVerifyExpired' : undefined
    );
  };

  const runAdd = async (authorization: string, origin: string | undefined) => {
    if (!isCurrentAccount(origin)) {
      return;
    }
    setIsAdding(true);
    try {
      const result = await registerPasskey({ managementAuthorization: authorization });
      if (!isCurrentAccount(origin)) {
        return;
      }
      if (result.status === 'ok') {
        toast.success(t('profile.passkeyAdded'));
        options.onListChanged();
        return;
      }
      switch (result.failure) {
        case 'cancelled': {
          // The sheet was dismissed: nothing was written.
          toast.error(t('profile.passkeyAddCancelled'));
          return;
        }
        case 'management-required': {
          reopenVerification('enroll', auth => void runAdd(auth, origin), 'required');
          return;
        }
        case 'authorization-invalid': {
          reopenVerification('enroll', auth => void runAdd(auth, origin), 'invalid');
          return;
        }
        case 'session-ended': {
          toast.error(t('login.sessionEnded'));
          return;
        }
        // A plain failure keeps the control as the retry; the two device
        // refusals withdraw it, and the notice says which.
        case 'unsupported':
        case 'device-unsupported':
        case 'failed': {
          setAddFailure(result.failure);
          return;
        }
        default: {
          // Every refusal the authority defines is listed; a new one lands
          // here as a plain failure rather than as a silent success.
          setAddFailure('failed');
        }
      }
    } catch {
      // A rejection — the request-token read behind the ceremony, say — wrote
      // nothing, so the same control starts a fresh attempt.
      if (isCurrentAccount(origin)) {
        setAddFailure('failed');
      }
    } finally {
      // Always: a rejection must not leave the control loading forever.
      setIsAdding(false);
    }
  };

  const runRemove = async (id: string, authorization: string, origin: string | undefined) => {
    if (!isCurrentAccount(origin)) {
      return;
    }
    try {
      await remove.mutateAsync({ id, managementAuthorization: authorization });
    } catch (error) {
      if (!isCurrentAccount(origin)) {
        return;
      }
      const refusal = managementRefusal(error);
      if (refusal !== null) {
        reopenVerification('remove', auth => void runRemove(id, auth, origin), refusal);
      }
      // Every other refusal already rolled the row back and toasted.
    }
  };

  const runRename = async (request: {
    passkey: PasskeyRow;
    name: string;
    authorization: string;
    origin: string | undefined;
  }) => {
    const { passkey, name, authorization, origin } = request;
    if (!isCurrentAccount(origin)) {
      return;
    }
    try {
      await rename.mutateAsync({
        id: passkey.id,
        name,
        managementAuthorization: authorization,
      });
    } catch (error) {
      if (!isCurrentAccount(origin)) {
        return;
      }
      const refusal = managementRefusal(error);
      if (refusal !== null) {
        reopenVerification(
          'rename',
          auth => void runRename({ passkey, name, authorization: auth, origin }),
          refusal
        );
      }
      // Every other refusal already toasted.
    }
  };

  // The removal failure stays actionable while the delete it names is in
  // flight and after that delete rolls the row back. Once a reconciled list no
  // longer holds the passkey, the same delete can only fail again, so the
  // notice goes away with the row it referred to.
  const removalInFlight = remove.isPending && remove.variables.id === failedRemoveId;
  const removeFailureId =
    failedRemoveId !== null &&
    (removalInFlight || options.passkeys.some(passkey => passkey.id === failedRemoveId))
      ? failedRemoveId
      : null;

  return {
    verification,
    verifying,
    isAdding,
    addFailure,
    // A device that cannot create passkeys, or a sign-in that cannot manage
    // them at all, must not offer a control whose only possible result is that
    // refusal. Any other failure keeps it, because it starts a fresh attempt.
    canCreatePasskeys:
      passkeysSupported() && addFailure !== 'unsupported' && addFailure !== 'device-unsupported',
    removeFailureId,
    removalInFlight,
    removing: remove.isPending,
    handleAddPasskey: () => {
      if (isAdding || verifying) {
        return;
      }
      setAddFailure(null);
      const origin = accountRef.current;
      verification.open('enroll', authorization => {
        void runAdd(authorization, origin);
      });
    },
    handleRemovePasskey: id => {
      const origin = accountRef.current;
      verification.open('remove', authorization => {
        void runRemove(id, authorization, origin);
      });
    },
    handleRetryRemove: () => {
      if (removeFailureId === null) {
        return;
      }
      const id = removeFailureId;
      const origin = accountRef.current;
      verification.open('remove', authorization => {
        void runRemove(id, authorization, origin);
      });
    },
    // The name is captured now and written after the proof: a dismissed panel
    // writes nothing, so the modal can close as soon as it is saved.
    handleRenamePasskey: (passkey, name) => {
      const origin = accountRef.current;
      verification.open('rename', authorization => {
        void runRename({ passkey, name, authorization, origin });
      });
    },
  };
}
