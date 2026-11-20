import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { notificationHaptic } from '@/lib/haptics';
import { useFocusEffect, useRouter } from 'expo-router';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, View } from 'react-native';
import { toast } from 'sonner-native';

import { QueryError } from '@/components/query-error';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { SheetTitleRow } from '@/components/sheet-title-row';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { Button } from '@/components/ui/button';
import { ListTodo } from '@/components/ui/icons';
import { IconTile } from '@/components/ui/icon-tile';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { NEUTRAL_TINT } from '@/lib/agent-color';
import { i18n } from '@/i18n';
import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { isSignOutActive } from '@/lib/auth/sign-out-state';
import {
  isExpectedAuthFailure,
  settledTrpcUnauthorizedHandling,
} from '@/lib/auth/trpc-unauthorized';
import { invalidateTodoQueries, useTodoLists } from '@/lib/hooks/use-todos';
import { useKeyedSurfaceFeedback } from '@/lib/hooks/use-surface-feedback';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useDetailScreenBottomPadding } from '@/lib/screen-insets';
import { SCREEN_GUTTER_CLASS } from '@/lib/layout';
import { assertSurfaceFailureHandled } from '@/lib/surface-feedback';
import { todoFromDraft } from '@/lib/todos/todo-model';
import { todoListSettingsPath } from '@/lib/todos/todo-routes';
import { type TodoList } from '@/lib/todos/todo-types';
import { useTRPC } from '@/lib/trpc';
import { isRetryableTrpcError } from '@/lib/trpc-error';
import { cn } from '@/lib/utils';

import { TODO_SHEET_STATE_BODY_CLASS } from './todo-sheet-body';

type SaveDraftAsTodoSheetProps = {
  visible: boolean;
  organizationId: string | null;
  /** Read when a list is picked, so the saved to-do is the draft as it stands. */
  getDraft: () => string;
  onSaved: () => void;
  onClose: () => void;
};

/**
 * A failed save, shown under the row it was for. The sheet is its own native
 * window, so a toast would draw behind it until it closed; the line keeps the
 * report beside the rows the retry needs. `retryable` covers a request that got
 * no answer (offline, timed out) and a server that may answer next time;
 * `refused` is a list the server will not take the to-do into.
 */
type SaveFailure =
  | { readonly kind: 'retryable'; readonly message: string }
  | { readonly kind: 'refused'; readonly message: string };

/**
 * The failure a rejected save reports, or `null` when the sheet has nothing to
 * say. The draft stays in the composer either way: only a saved to-do lets the
 * screen discard it. A refused session credential reaches the auth handler
 * through the mutation cache. When that handler ends the session, its own toast
 * is the report, and the draft waits for the same account's next sign-in; when
 * it renews the token, the same tap can now succeed.
 */
async function saveFailure(error: unknown, epoch: number): Promise<SaveFailure | null> {
  if (isExpectedAuthFailure(error)) {
    // Waits for the handler run the mutation cache started for this error.
    await settledTrpcUnauthorizedHandling();
    if (!isCurrentAuthEpoch(epoch) || isSignOutActive()) {
      return null;
    }
    return { kind: 'retryable', message: i18n.t('todos.saveSheet.saveFailed') };
  }
  if (isRetryableTrpcError(error)) {
    return { kind: 'retryable', message: i18n.t('todos.saveSheet.saveFailed') };
  }
  return { kind: 'refused', message: i18n.t('todos.saveSheet.saveRefused') };
}

function SaveFailureLine({ failure }: Readonly<{ failure: SaveFailure }>) {
  switch (failure.kind) {
    case 'retryable':
    case 'refused': {
      return (
        <AccessibleStatus
          message={failure.message}
          className={cn(SCREEN_GUTTER_CLASS, 'pb-3 text-sm')}
        />
      );
    }
    default: {
      return assertSurfaceFailureHandled(failure);
    }
  }
}

/**
 * The list picker behind the new-session discard confirm's "Save as to-do":
 * the draft's first line becomes the title and the rest its notes.
 */
export function SaveDraftAsTodoSheet({
  visible,
  organizationId,
  getDraft,
  onSaved,
  onClose,
}: Readonly<SaveDraftAsTodoSheetProps>) {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const router = useRouter();
  const queryClient = useQueryClient();
  const colors = useThemeColors();
  const bottomClearance = useDetailScreenBottomPadding();
  const lists = useTodoLists(organizationId, visible);
  // One save at a time, keyed by its list: the pending key names the row that
  // spins, and a failure stays under the row it was for until the next save.
  const { snapshot, begin, clearWhere } = useKeyedSurfaceFeedback<string, SaveFailure>();
  const savingListId = snapshot.pendingKeys[0] ?? null;
  // Through the query client, so the mutation cache sees a failure: a 401
  // there goes to the auth handler, as it does for every other mutation.
  // `networkMode: 'always'` keeps an offline save settling with its network
  // error instead of pausing: a paused save would hold the rows disabled and
  // could resume after the sheet closed, discarding the draft then.
  const createTodo = useMutation(
    trpc.todos.items.create.mutationOptions({ networkMode: 'always' })
  );
  // The create-list route is a formSheet, and the native sheet stacks above a
  // formSheet route: with the sheet up, the form would render behind it. Drop
  // the sheet while the form is open and restore it on return, so the picker
  // the user comes back to is the one they left.
  const [hiddenForCreate, setHiddenForCreate] = useState(false);
  const openCreateList = useCallback(() => {
    setHiddenForCreate(true);
    // Return here rather than to the created list: the draft this picker saves is
    // still in the composer, and the new list is the one it is about to go into.
    router.push(todoListSettingsPath({ organizationId, afterCreate: 'back' }));
  }, [organizationId, router]);
  useFocusEffect(
    useCallback(() => {
      setHiddenForCreate(false);
    }, [])
  );
  const activeLists = (lists.data ?? []).filter(list => list.archivedAt === null);
  const shown = visible && !hiddenForCreate;

  function clearFailures() {
    for (const key of snapshot.states.keys()) {
      clearWhere(key, () => true);
    }
  }
  // Closing retires a failure the sheet already showed, so the report below
  // covers only a save that settles after the sheet is gone.
  function close() {
    clearFailures();
    onClose();
  }
  // A failure the closed sheet cannot show (its save settled after the close)
  // is reported on the screen underneath instead, where a toast draws once the
  // sheet window is gone: the same copy as the line, never the raw error.
  useEffect(() => {
    if (shown) {
      return;
    }
    for (const [key, state] of snapshot.states) {
      if (state.status === 'failed') {
        toast.error(state.failure.message);
        clearWhere(key, () => true);
      }
    }
  }, [shown, snapshot, clearWhere]);

  async function save(list: TodoList) {
    const todo = todoFromDraft(getDraft());
    if (!todo || savingListId !== null) {
      return;
    }
    const attempt = begin(list.id);
    if (attempt === null) {
      return;
    }
    const epoch = currentAuthEpoch();
    // The sheet reports one failure: a new attempt retires another row's line.
    clearFailures();
    try {
      await createTodo.mutateAsync({ listId: list.id, ...todo });
    } catch (error) {
      // The rows stay locked until the failure is classified, so a second tap
      // cannot succeed first and then be followed by this attempt's failure.
      const failure = await saveFailure(error, epoch);
      if (failure === null) {
        attempt.abandon();
      } else {
        attempt.fail(failure);
      }
      return;
    }
    // A saved to-do closes the sheet, so the success has no line of its own.
    attempt.abandon();
    // A save that settles after the account changed must not discard the
    // draft or announce itself to the next account.
    if (!isCurrentAuthEpoch(epoch)) {
      return;
    }
    void invalidateTodoQueries(queryClient, trpc);
    notificationHaptic(Haptics.NotificationFeedbackType.Success);
    toast.success(t('todos.saveSheet.saved', { list: list.name }));
    onSaved();
  }

  let body: ReactNode = null;
  if (lists.isPending) {
    body = (
      <View className={cn('items-center', TODO_SHEET_STATE_BODY_CLASS)}>
        <ActivityIndicator />
      </View>
    );
  } else if (lists.isError) {
    body = (
      <QueryError
        placement="static"
        inset="gutter"
        onRetry={() => void lists.refetch()}
        isRetrying={lists.isFetching}
      />
    );
  } else if (activeLists.length === 0) {
    body = (
      <View className={cn('gap-4', TODO_SHEET_STATE_BODY_CLASS)}>
        <Text className="text-center text-sm text-muted-foreground">{t('todos.lists.empty')}</Text>
        <Button
          variant="outline"
          onPress={openCreateList}
          accessibilityLabel={t('todos.lists.newList')}
        >
          <Text>{t('todos.lists.newList')}</Text>
        </Button>
      </View>
    );
  } else {
    body = activeLists.map(list => {
      const feedback = snapshot.states.get(list.id);
      return (
        <View key={list.id} className="border-b-[0.5px] border-hair-soft">
          <Pressable
            disabled={savingListId !== null}
            onPress={() => void save(list)}
            accessibilityRole="button"
            accessibilityLabel={list.name}
            accessibilityState={{ disabled: savingListId !== null }}
            className="min-h-14 flex-row items-center gap-3 px-4 py-3 active:opacity-70"
          >
            <IconTile
              tint={NEUTRAL_TINT}
              icon={list.emoji ? undefined : ListTodo}
              content={list.emoji ? <Text className="text-base">{list.emoji}</Text> : undefined}
            />
            <Text className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={1}>
              {list.name}
            </Text>
            {savingListId === list.id ? <ActivityIndicator color={colors.mutedForeground} /> : null}
          </Pressable>
          {feedback?.status === 'failed' ? <SaveFailureLine failure={feedback.failure} /> : null}
        </View>
      );
    });
  }

  return (
    <Sheet
      visible={shown}
      onClose={() => {
        // The hide-for-create flip arms the native sheet's own dismissal, which
        // reports through `onClose`; that report is not the user closing the
        // sheet, so only a dismissal while the sheet is actually shown reaches
        // the caller.
        if (!hiddenForCreate) {
          close();
        }
      }}
      // The body scrolls, so the native sheet's drag would dismiss it on a
      // scroll and the iOS backdrop tap is gone with it; the title row's close
      // control and Android Back are this sheet's exits.
      dismissGestures={false}
      snapPoints={['60%']}
    >
      {/* The title row takes the under-handle padding itself. */}
      <View className="flex-1">
        <SheetTitleRow title={t('todos.saveSheet.title')} onClose={close} />
        <ScrollView nestedScrollEnabled contentContainerStyle={{ paddingBottom: bottomClearance }}>
          {body}
        </ScrollView>
      </View>
    </Sheet>
  );
}
