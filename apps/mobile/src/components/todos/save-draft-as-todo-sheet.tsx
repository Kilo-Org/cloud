import { useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { toast } from 'sonner-native';

import { QueryError } from '@/components/query-error';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { ListTodo } from '@/components/ui/icons';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { invalidateTodoQueries, useTodoLists } from '@/lib/hooks/use-todos';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { todoFromDraft } from '@/lib/todos/todo-model';
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
  const queryClient = useQueryClient();
  const colors = useThemeColors();
  const { bottom } = useSafeAreaInsets();
  const lists = useTodoLists(organizationId, visible);
  const [savingListId, setSavingListId] = useState<string | null>(null);
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
      <Text className="px-5 py-8 text-center text-sm text-muted-foreground">
        {t('todos.lists.empty')}
      </Text>
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
    <Sheet visible={visible} onClose={onClose} snapPoints={['60%']}>
      <View className="flex-1 pt-4">
        <Text accessibilityRole="header" className="px-5 pb-2 text-base font-semibold">
          {t('todos.saveSheet.title')}
        </Text>
        <ScrollView contentContainerStyle={{ paddingBottom: bottom + 16 }}>{body}</ScrollView>
      </View>
    </Sheet>
  );
}
