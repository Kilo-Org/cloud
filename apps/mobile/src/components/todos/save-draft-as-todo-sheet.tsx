import { useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { useFocusEffect, useRouter } from 'expo-router';
import { type ReactNode, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { toast } from 'sonner-native';

import { QueryError } from '@/components/query-error';
import { SheetTitleRow } from '@/components/sheet-title-row';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { Button } from '@/components/ui/button';
import { ListTodo } from '@/components/ui/icons';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { invalidateTodoQueries, useTodoLists } from '@/lib/hooks/use-todos';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { todoFromDraft } from '@/lib/todos/todo-model';
import { todoListSettingsPath } from '@/lib/todos/todo-routes';
import { type TodoList } from '@/lib/todos/todo-types';
import { trpcClient, useTRPC } from '@/lib/trpc';

type SaveDraftAsTodoSheetProps = {
  visible: boolean;
  organizationId: string | null;
  /** Read when a list is picked, so the saved to-do is the draft as it stands. */
  getDraft: () => string;
  onSaved: () => void;
  onClose: () => void;
};

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
  const { bottom } = useSafeAreaInsets();
  const lists = useTodoLists(organizationId, visible);
  const [savingListId, setSavingListId] = useState<string | null>(null);
  // The create-list route is a formSheet, and the native sheet stacks above a
  // formSheet route: with the sheet up, the form would render behind it. Drop
  // the sheet while the form is open and restore it on return, so the picker
  // the user comes back to is the one they left.
  const [hiddenForCreate, setHiddenForCreate] = useState(false);
  const openCreateList = useCallback(() => {
    setHiddenForCreate(true);
    router.push(todoListSettingsPath({ organizationId }));
  }, [organizationId, router]);
  useFocusEffect(
    useCallback(() => {
      setHiddenForCreate(false);
    }, [])
  );
  const activeLists = (lists.data ?? []).filter(list => list.archivedAt === null);

  async function save(list: TodoList) {
    const todo = todoFromDraft(getDraft());
    if (!todo || savingListId !== null) {
      return;
    }
    setSavingListId(list.id);
    try {
      await trpcClient.todos.items.create.mutate({ listId: list.id, ...todo });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : i18n.t('common.somethingWentWrong'));
      setSavingListId(null);
      return;
    }
    void invalidateTodoQueries(queryClient, trpc);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    toast.success(t('todos.saveSheet.saved', { list: list.name }));
    setSavingListId(null);
    onSaved();
  }

  let body: ReactNode = null;
  if (lists.isPending) {
    body = (
      <View className="items-center py-8">
        <ActivityIndicator />
      </View>
    );
  } else if (lists.isError) {
    body = (
      <QueryError
        placement="static"
        onRetry={() => void lists.refetch()}
        isRetrying={lists.isFetching}
      />
    );
  } else if (activeLists.length === 0) {
    body = (
      <View className="gap-4 px-5 py-8">
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
    body = activeLists.map(list => (
      <Pressable
        key={list.id}
        disabled={savingListId !== null}
        onPress={() => void save(list)}
        accessibilityRole="button"
        accessibilityLabel={list.name}
        accessibilityState={{ disabled: savingListId !== null }}
        className="min-h-14 flex-row items-center gap-3 border-b border-hair-soft px-5 py-2 active:opacity-70"
      >
        <View className="size-8 items-center justify-center rounded-lg bg-secondary">
          {list.emoji ? (
            <Text className="text-base">{list.emoji}</Text>
          ) : (
            <ListTodo size={16} color={colors.mutedForeground} />
          )}
        </View>
        <Text className="min-w-0 flex-1 text-base text-foreground" numberOfLines={1}>
          {list.name}
        </Text>
        {savingListId === list.id ? <ActivityIndicator color={colors.mutedForeground} /> : null}
      </Pressable>
    ));
  }

  return (
    <Sheet
      visible={visible && !hiddenForCreate}
      onClose={() => {
        // The hide-for-create flip arms the native sheet's own dismissal, which
        // reports through `onClose`; that report is not the user closing the
        // sheet, so only a dismissal while the sheet is actually shown reaches
        // the caller.
        if (!hiddenForCreate) {
          onClose();
        }
      }}
      // The body scrolls, so the native sheet's drag would dismiss it on a
      // scroll and the iOS backdrop tap is gone with it; the title row's close
      // control and Android Back are this sheet's exits.
      dismissGestures={false}
      snapPoints={['60%']}
    >
      <View className="flex-1 pt-4">
        <SheetTitleRow title={t('todos.saveSheet.title')} onClose={onClose} />
        <ScrollView contentContainerStyle={{ paddingBottom: bottom + 16 }}>{body}</ScrollView>
      </View>
    </Sheet>
  );
}
