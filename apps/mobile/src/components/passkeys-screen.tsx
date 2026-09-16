import { hashKey, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, View } from 'react-native';
import { toast } from 'sonner-native';

import { EmptyState } from '@/components/empty-state';
import {
  PasskeyListRow,
  type PasskeyRow,
  type PasskeysResult,
} from '@/components/passkey-list-row';
import { QueryError } from '@/components/query-error';
import { RenameModal } from '@/components/rename-modal';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { KeyRound, Plus } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useAuth } from '@/lib/auth/auth-context';
import { registerPasskey } from '@/lib/auth/passkey-client';
import {
  isLatestMutationGeneration,
  nextMutationGeneration,
} from '@/lib/hooks/mutation-generations';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useTRPC } from '@/lib/trpc';

/**
 * Why the Add control did not add a row. Both keep the Add CTA: creation has no
 * half-written credential to clean up, so the same control starts a fresh
 * ceremony, and it never retries by itself.
 */
type AddFailure = 'unsupported' | 'failed';

/** Rows the skeleton reserves so loading→content does not resize the list. */
const SKELETON_ROWS = [0, 1, 2];

/**
 * A failure the user can retry in place, with the rows it sits beside left
 * rendered. The retry control is the only action: a failed request refused
 * nothing about the credential, so the same operation is a working retry.
 *
 * `pending` is the retried request's own in-flight state. It disables and
 * loads the control so a second tap cannot start a concurrent duplicate of the
 * request the first tap already sent.
 */
function InlineFailure({
  message,
  onRetry,
  pending,
}: Readonly<{ message: string; onRetry: () => void; pending: boolean }>) {
  const { t } = useTranslation();
  return (
    <View className="flex-row items-center gap-3 rounded-lg border border-border bg-card p-3">
      <Text accessibilityRole="alert" className="min-w-0 flex-1 text-sm text-muted-foreground">
        {message}
      </Text>
      <Button variant="outline" size="sm" loading={pending} onPress={onRetry}>
        <Text>{t('common.retry')}</Text>
      </Button>
    </View>
  );
}

/**
 * Passkeys for the signed-in user: the list, creation through the platform
 * authenticator, rename, and removal behind a confirmation.
 *
 * Four states: loading reserves the final rows' boxes, empty offers creation as
 * its only action, happy lists a row per passkey, and a failure is either
 * retryable in place (the list request or a removal, with the rows it was shown
 * with kept) or non-retryable (no native passkey module, or the platform
 * refused the creation, where the Add CTA remains the recovery). A cancelled
 * creation sheet changed nothing, so the list is left as it was and the toast
 * says so. A retry is single-flight — its control is disabled while the request
 * it starts is pending — and a removal failure is only actionable while that
 * delete runs or its row has rolled back, never after the server list drops it.
 */
export function PasskeysScreen() {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const colors = useThemeColors();
  const { token } = useAuth();

  const listKey = trpc.user.getPasskeys.queryKey();
  // Stable per-cache key for the removal generations: overlapping removals must
  // not let an older failure's snapshot overwrite a newer one's state.
  const removalKey = hashKey(listKey);
  const { data, isPending, isError, isFetching, refetch } = useQuery({
    ...trpc.user.getPasskeys.queryOptions(),
    enabled: token != null,
  });
  const passkeys = data?.passkeys ?? [];

  const [renameTarget, setRenameTarget] = useState<PasskeyRow | null>(null);
  const [failedRemoveId, setFailedRemoveId] = useState<string | null>(null);
  const [addFailure, setAddFailure] = useState<AddFailure | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  const remove = useMutation(
    trpc.user.deletePasskey.mutationOptions({
      // The delete is the obviously reversible one: drop the row now and put it
      // back from the snapshot when the server refuses.
      onMutate: async ({ id }) => {
        await queryClient.cancelQueries({ queryKey: listKey });
        const generation = nextMutationGeneration(removalKey);
        const previous = queryClient.getQueryData<PasskeysResult>(listKey);
        queryClient.setQueryData<PasskeysResult>(listKey, old =>
          old ? { ...old, passkeys: old.passkeys.filter(passkey => passkey.id !== id) } : old
        );
        return { previous, generation };
      },
      onError: (error, { id }, context) => {
        // Only the newest removal owns the cache: an older failure's snapshot
        // predates a newer removal's optimistic write, so replaying it would
        // resurrect the row the newer removal already took over. The newer
        // write reconciles with the server at settle.
        if (context && isLatestMutationGeneration(removalKey, context.generation)) {
          queryClient.setQueryData(listKey, context.previous);
          setFailedRemoveId(id);
        }
        toast.error(error.message);
      },
      onSuccess: (_result, { id }, context) => {
        if (isLatestMutationGeneration(removalKey, context.generation)) {
          setFailedRemoveId(current => (current === id ? null : current));
        }
        toast.success(t('profile.passkeyRemoved'));
      },
      // Reconcile with the server either way, so a rollback cannot leave a row
      // the server does not have or hide one it does.
      onSettled: () => {
        void refetch();
      },
    })
  );

  // The removal failure stays actionable while the delete it names is in
  // flight and after that delete rolls the row back. Once a reconciled list no
  // longer holds the passkey, the same delete can only fail again, so the
  // notice goes away with the row it referred to.
  const removalInFlight = remove.isPending && remove.variables.id === failedRemoveId;
  const removeFailureId =
    failedRemoveId !== null &&
    (removalInFlight || passkeys.some(passkey => passkey.id === failedRemoveId))
      ? failedRemoveId
      : null;

  const rename = useMutation(
    trpc.user.renamePasskey.mutationOptions({
      onSuccess: () => {
        toast.success(t('profile.passkeyRenamed'));
        void refetch();
      },
      // A failed rename must reach the user even if the modal is dismissed,
      // so the hook reports it (apps/mobile/AGENTS.md); RenameModal also keeps
      // the message inline while it stays open for another try.
      onError: error => {
        toast.error(error.message);
      },
    })
  );

  const confirmRemove = (passkey: PasskeyRow) => {
    Alert.alert(t('profile.removePasskeyTitle'), t('profile.removePasskeyMessage'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.remove'),
        style: 'destructive',
        onPress: () => {
          remove.mutate({ id: passkey.id });
        },
      },
    ]);
  };

  const handleAdd = async () => {
    if (isAdding) {
      return;
    }
    setAddFailure(null);
    setIsAdding(true);
    const result = await registerPasskey();
    setIsAdding(false);

    if (result.status === 'ok') {
      toast.success(t('profile.passkeyAdded'));
      void refetch();
      return;
    }
    if (result.failure === 'cancelled') {
      // The sheet was dismissed: nothing was written, so the list is unchanged.
      toast.error(t('profile.passkeyAddCancelled'));
      return;
    }
    setAddFailure(result.failure === 'unsupported' ? 'unsupported' : 'failed');
  };

  const addButton = (
    <Button
      variant="outline"
      loading={isAdding}
      onPress={() => {
        void handleAdd();
      }}
    >
      <Plus size={16} color={colors.foreground} />
      <Text>{t('profile.addPasskey')}</Text>
    </Button>
  );

  const addFailureNotice =
    addFailure === null ? null : (
      <Text accessibilityRole="alert" className="text-sm text-muted-foreground">
        {addFailure === 'unsupported'
          ? t('profile.passkeyAddUnsupported')
          : t('profile.passkeyAddFailed')}
      </Text>
    );

  let failureNotice: ReactNode = null;
  if (removeFailureId !== null) {
    failureNotice = (
      <InlineFailure
        message={t('profile.passkeyRemoveFailed')}
        pending={remove.isPending}
        onRetry={() => {
          remove.mutate({ id: removeFailureId });
        }}
      />
    );
  } else if (isError && data !== undefined) {
    // A background refresh failed. Whatever was already on screen stays, and
    // the retry re-runs the same request.
    failureNotice = (
      <InlineFailure
        message={t('profile.passkeysCouldNotLoad')}
        pending={isFetching}
        onRetry={() => {
          void refetch();
        }}
      />
    );
  }

  let body: ReactNode = null;
  if (isPending) {
    // Loading is checked ahead of error and empty: the first frame of a cold
    // open must be the skeleton, never the empty state.
    body = (
      <>
        <View className="gap-3">
          {SKELETON_ROWS.map(index => (
            <View key={index} className="flex-row items-center gap-3 rounded-lg bg-secondary p-3">
              <Skeleton className="h-[18px] w-[18px] rounded" />
              <View className="flex-1 gap-1.5">
                <Skeleton className="h-5 w-28" />
                <Skeleton className="h-4 w-40" />
              </View>
              {/* Reserve the row controls' final 44x44pt boxes (the glyphs stay
                  16pt) so a loaded row is the same height as its skeleton. */}
              <View className="min-h-[44px] min-w-[44px] items-center justify-center">
                <Skeleton className="h-4 w-4 rounded" />
              </View>
              <View className="min-h-[44px] min-w-[44px] items-center justify-center">
                <Skeleton className="h-4 w-4 rounded" />
              </View>
            </View>
          ))}
        </View>
        {addButton}
      </>
    );
  } else if (isError && data === undefined) {
    body = (
      <QueryError
        variant="server"
        placement="top"
        title={t('profile.passkeysCouldNotLoad')}
        message={t('profile.passkeysLoadFailed')}
        onRetry={() => {
          void refetch();
        }}
        isRetrying={isFetching}
      />
    );
  } else if (passkeys.length === 0) {
    body = (
      <EmptyState
        placement="top"
        icon={KeyRound}
        title={t('profile.passkeysEmpty')}
        description={t('profile.passkeysEmptyHint')}
        action={
          <>
            {addFailureNotice}
            {addButton}
          </>
        }
      />
    );
  } else {
    body = (
      <>
        {failureNotice}
        <View className="gap-3">
          {passkeys.map(passkey => (
            <PasskeyListRow
              key={passkey.id}
              passkey={passkey}
              disabled={remove.isPending}
              onRename={setRenameTarget}
              onRemove={confirmRemove}
            />
          ))}
        </View>
        {addFailureNotice}
        {addButton}
      </>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('profile.passkeysTitle')} />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName="gap-3 px-6 pt-4"
        showsVerticalScrollIndicator={false}
      >
        {body}
      </TabScreenScrollView>

      {renameTarget && (
        <RenameModal
          title={t('profile.renamePasskey')}
          placeholder={t('profile.passkeyName')}
          initialValue={renameTarget.name ?? ''}
          maxLength={64}
          onSave={async name => {
            await rename.mutateAsync({ id: renameTarget.id, name });
          }}
          onClose={() => {
            setRenameTarget(null);
          }}
        />
      )}
    </View>
  );
}
