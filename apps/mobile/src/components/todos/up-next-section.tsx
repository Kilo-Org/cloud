import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { SectionHeader } from '@/components/home/section-header';
import { useStartTodo } from '@/components/todos/use-start-todo';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { ListTodo, Play } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { useTodoLists, useUpNextTodos } from '@/lib/hooks/use-todos';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { todoItemPath } from '@/lib/todos/todo-routes';

/** Home's next three open to-dos, each with Start. Hidden while there are none. */
export function UpNextSection({
  organizationId,
  enabled,
}: Readonly<{ organizationId: string | null; enabled: boolean }>) {
  const { t } = useTranslation();
  const router = useRouter();
  const colors = useThemeColors();
  const upNext = useUpNextTodos(organizationId, enabled);
  const lists = useTodoLists(organizationId, enabled);
  const { review, startNow, startingTodoId } = useStartTodo();
  const items = upNext.data ?? [];

  if (items.length === 0) {
    return null;
  }
  return (
    <View>
      <SectionHeader label={t('todos.upNext')} />
      {items.map(item => {
        const list = lists.data?.find(candidate => candidate.id === item.listId);
        return (
          <View key={item.id} className="mx-4 min-h-14 flex-row items-center gap-3">
            <Pressable
              onPress={() => {
                router.push(todoItemPath(item.id));
              }}
              accessibilityRole="button"
              accessibilityLabel={item.title}
              className="min-w-0 flex-1 flex-row items-center gap-3 py-2 active:opacity-70"
            >
              <View className="size-8 items-center justify-center rounded-lg bg-secondary">
                {item.listEmoji ? (
                  <Text className="text-base">{item.listEmoji}</Text>
                ) : (
                  <ListTodo size={16} color={colors.mutedForeground} />
                )}
              </View>
              <View className="min-w-0 flex-1">
                <Text className="text-base text-foreground" numberOfLines={1}>
                  {item.title}
                </Text>
                <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                  {item.listName}
                </Text>
              </View>
            </Pressable>
            <Pressable
              disabled={!list || startingTodoId === item.id}
              onPress={() => {
                if (list) {
                  review(item, list);
                }
              }}
              onLongPress={() => {
                if (list) {
                  void startNow(item, list);
                }
              }}
              accessibilityRole="button"
              accessibilityLabel={t('agentChat.newSession.startSession')}
              accessibilityHint={t('todos.item.startNowHint')}
              accessibilityState={{ disabled: !list }}
              className="size-10 items-center justify-center rounded-full bg-secondary active:opacity-70"
            >
              {startingTodoId === item.id ? (
                <ActivityIndicator color={colors.foreground} />
              ) : (
                <Play size={16} color={colors.foreground} />
              )}
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}
