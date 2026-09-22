import { hashKey, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, ScrollView, View } from 'react-native';
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
import { useTabBarBottomPadding } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { KeyRound, Plus } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useAuth } from '@/lib/auth/auth-context';
import { passkeysSupported, registerPasskey } from '@/lib/auth/passkey-client';
import {
  isLatestMutationGeneration,
  nextMutationGeneration,
} from '@/lib/hooks/mutation-generations';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useTRPC } from '@/lib/trpc';

/**
 * Why the Add control did not add a row. A ceremony that failed has no
 * half-written credential to clean up, so the same control is a working retry;
 * an `unsupported` result removes the control instead, because a device that
 * has just refused the ceremony cannot create one.
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
 * retryable in place (the list request or a removal, with whatever the query
 * last rendered kept — the rows or the empty state) or non-retryable (a device
 * that cannot create passkeys: the Add control is not offered, and the
 * unsupported notice takes the hint's place while the existing rows stay). A
 * cancelled creation sheet changed nothing, so the list is left as it was and
 * the toast says so. A retry is single-flight — its control is disabled while
 * the request it starts is pending — and a removal failure is only actionable
 * while that delete runs or its row has rolled back, never after the server
 * list drops it.
 *
 * The Add control is the screen's one action and sits outside the scrolling
 * list, in the footer above the tab bar: the header and the control then keep
 * the same coordinates whatever the query renders (skeletons, no rows, rows),
 * so data arriving never moves the control the user is reaching for.
 */
export function PasskeysScreen() {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const colors = useThemeColors();
  const { token } = useAuth();
  const tabBarBottomPadding = useTabBarBottomPadding();

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

  // A build without the native passkey module, or a platform that cannot hold
  // one, must not offer an Add control whose only possible result is the
  // unsupported notice — the login screen reads the same synchronous gate
  // before it renders its passkey button. A ceremony that comes back
  // `unsupported` proves the same thing, so it drops the control too; any other
  // failure keeps it, because the same control starts a fresh ceremony.
  const canCreatePasskeys = passkeysSupported() && addFailure !== 'unsupported';

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
        // The destructive action names itself, the same pair every other
        // confirmation in the app uses (`profile.deleteAccountTitle` /
        // `profile.deleteAccountConfirm`): a bare "Remove" would not say what
        // the row is about to lose.
        text: t('profile.removePasskey'),
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
    try {
      const result = await registerPasskey();
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
    } catch {
      // A rejection — the request-token read behind the ceremony, say — wrote
      // nothing, so the same control starts a fresh ceremony.
      setAddFailure('failed');
    } finally {
      // Always: a rejection must not leave the control loading forever.
      setIsAdding(false);
    }
  };

  // The control is full width in every state, in its own footer slot. Its
  // label's box takes the row's remaining width, so the one line the platform
  // lays out always has room to spare: a label sized to its own content
  // measured at its longest word's width and wrapped onto a second line the
  // button's min height then clipped (e4/p3 spot check: "Add a / passkey" in a
  // full-width button). The label's right margin mirrors the glyph and its row
  // gap, which keeps the centred label on the button's own centre.
  const addControl = canCreatePasskeys ? (
    <Button
      variant="outline"
      className="w-full"
      loading={isAdding}
      onPress={() => {
        void handleAdd();
      }}
    >
      <Plus size={16} color={colors.foreground} />
      <Text className="mr-[24px] flex-1 text-center">{t('profile.addPasskey')}</Text>
    </Button>
  ) : null;

  // On a device that cannot create passkeys the notice is not a reaction to a
  // press: it is the reason no Add control is offered, shown beside the rows.
  let addFailureNotice: ReactNode = null;
  if (!canCreatePasskeys) {
    addFailureNotice = (
      <Text accessibilityRole="alert" className="text-sm text-muted-foreground">
        {t('profile.passkeyAddUnsupported')}
      </Text>
    );
  } else if (addFailure === 'failed') {
    addFailureNotice = (
      <Text accessibilityRole="alert" className="text-sm text-muted-foreground">
        {t('profile.passkeyAddFailed')}
      </Text>
    );
  }

  // The notice and the control it explains share the footer. The one exception
  // is the empty state on a device that cannot create passkeys: there the
  // notice replaces the hint that would name the withdrawn control, so the
  // footer must not repeat it.
  const footerNotice = passkeys.length === 0 && !canCreatePasskeys ? null : addFailureNotice;

  let failureNotice: ReactNode = null;
  if (removeFailureId !== null) {
    failureNotice = (
      <InlineFailure
        message={t('profile.passkeyRemoveFailed')}
        // The retry names one passkey's delete, so it is locked by that delete
        // alone: another removal in flight must not load this control.
        pending={removalInFlight}
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
    // With no passkey to list and no way to create one, the notice takes the
    // hint's place: "Add a passkey…" would instruct the control this device has
    // just withdrawn, and the notice is then the state's only content.
    //
    // A failed background refresh is reported above the empty state, not
    // hidden by it: the cached list is empty, so the notice is the only thing
    // that says the request failed and offers the retry.
    //
    // The state carries no action of its own: the Add control it describes
    // lives in the footer, where it holds the same coordinates whether the
    // query renders this state or a list of rows.
    body = (
      <>
        {failureNotice}
        <EmptyState
          placement="top"
          icon={KeyRound}
          title={t('profile.passkeysEmpty')}
          description={canCreatePasskeys ? t('profile.passkeysEmptyHint') : addFailureNotice}
        />
      </>
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
      </>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('profile.passkeysTitle')} />
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-3 px-6 pt-4"
        showsVerticalScrollIndicator={false}
      >
        {body}
      </ScrollView>

      {/* The Add control's slot: outside the scrolling body and above the tab
          bar, it holds the coordinates the empty state first shows it at while
          the query renders skeletons, no rows, or rows. The notice that
          explains a failed or unavailable add shares the slot, beside the
          control it is about. */}
      <View className="gap-2 px-6 pt-3" style={{ paddingBottom: tabBarBottomPadding }}>
        {footerNotice}
        {addControl}
      </View>

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
