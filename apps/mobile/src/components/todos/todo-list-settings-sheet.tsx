import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BackHandler, Pressable, View } from 'react-native';

import { normalizeAgentMode } from '@/components/agents/mode-normalize';
import { ModeSelector } from '@/components/agents/mode-selector';
import { ModelSelector } from '@/components/agents/model-selector';
import { RepoSelector } from '@/components/agents/repo-selector';
import { PickerSheet } from '@/components/picker-sheet';
import { QueryError } from '@/components/query-error';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { useSheetDismissGuard } from '@/components/ui/use-sheet-dismiss-guard';
import { useAvailableModels } from '@/lib/hooks/use-available-models';
import { useTodoListMutations, useTodoLists } from '@/lib/hooks/use-todos';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  TODO_LIST_EMOJI_MAX_LENGTH,
  TODO_LIST_NAME_MAX_LENGTH,
  todoListGitUrl,
  todoListRepoSelection,
} from '@/lib/todos/todo-model';
import { type TodoList } from '@/lib/todos/todo-types';
import { useNewSessionRepos } from '@/lib/use-new-session-repos';

type ListSettingsFormProps = {
  list: TodoList | null;
  organizationId: string | null;
};

function FieldLabel({ children }: Readonly<{ children: string }>) {
  return <Text className="text-sm font-medium text-foreground">{children}</Text>;
}

function ListSettingsForm({ list, organizationId }: Readonly<ListSettingsFormProps>) {
  const router = useRouter();
  const { t } = useTranslation();
  const colors = useThemeColors();
  const { create, update } = useTodoListMutations(organizationId);
  const scope = organizationId ?? undefined;
  const { repositories, recents, groups } = useNewSessionRepos({ organizationId: scope });
  const { models, isLoading: isLoadingModels } = useAvailableModels(scope);

  const nameRef = useRef(list?.name ?? '');
  const emojiRef = useRef(list?.emoji ?? '');
  const [hasName, setHasName] = useState(Boolean(list?.name.trim()));
  const [gitUrl, setGitUrl] = useState(list?.gitUrl ?? null);
  const [mode, setMode] = useState(list?.mode ?? null);
  const [model, setModel] = useState(list?.model ?? null);
  const [variant, setVariant] = useState(list?.variant ?? null);
  const saving = create.isPending;

  const { requestClose, dialog } = useSheetDismissGuard({
    isDirty: () =>
      nameRef.current !== (list?.name ?? '') ||
      emojiRef.current !== (list?.emoji ?? '') ||
      gitUrl !== (list?.gitUrl ?? null) ||
      mode !== (list?.mode ?? null) ||
      model !== (list?.model ?? null) ||
      variant !== (list?.variant ?? null),
    onDiscard: () => {
      router.back();
    },
  });

  // The screen is a native formSheet whose swipe is off, so Android Back is the
  // one dismissal the platform still offers; it asks the same question.
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      requestCloseRef.current();
      return true;
    });
    return () => {
      subscription.remove();
    };
  }, []);

  function save() {
    const name = nameRef.current.trim();
    if (name.length === 0) {
      return;
    }
    const emoji = emojiRef.current.trim();
    const fields = {
      name,
      emoji: emoji.length > 0 ? emoji : null,
      gitUrl,
      mode,
      model,
      variant,
    };
    if (list) {
      update.mutate({ id: list.id, ...fields });
      router.back();
      return;
    }
    create.mutate(
      { organizationId, ...fields },
      {
        onSuccess: () => {
          router.back();
        },
      }
    );
  }

  return (
    <>
      <PickerSheet
        title={list ? t('todos.listSettings.title') : t('todos.lists.newList')}
        doneLabel={t('common.save')}
        onDone={save}
        onCancel={requestClose}
        disabled={!hasName || saving}
      >
        <View className="gap-5 px-4 pt-2">
          <View className="flex-row gap-3">
            <View className="w-20 gap-2">
              <FieldLabel>{t('todos.listSettings.emoji')}</FieldLabel>
              <Input
                defaultValue={list?.emoji ?? ''}
                onChangeText={text => {
                  emojiRef.current = text;
                }}
                maxLength={TODO_LIST_EMOJI_MAX_LENGTH}
                accessibilityLabel={t('todos.listSettings.emoji')}
                className="rounded-lg border border-border bg-secondary text-base text-foreground"
              />
            </View>
            <View className="min-w-0 flex-1 gap-2">
              <FieldLabel>{t('todos.listSettings.name')}</FieldLabel>
              <Input
                defaultValue={list?.name ?? ''}
                autoFocus={!list}
                onChangeText={text => {
                  nameRef.current = text;
                  const next = text.trim().length > 0;
                  setHasName(current => (current === next ? current : next));
                }}
                onSubmitEditing={save}
                returnKeyType="done"
                maxLength={TODO_LIST_NAME_MAX_LENGTH}
                placeholder={t('todos.listSettings.namePlaceholder')}
                accessibilityLabel={t('todos.listSettings.name')}
                className="rounded-lg border border-border bg-secondary text-base text-foreground"
              />
            </View>
          </View>

          <Text className="text-sm text-muted-foreground">
            {t('todos.listSettings.defaultsHint')}
          </Text>

          <View className="gap-2">
            <View className="flex-row items-center justify-between">
              <FieldLabel>{t('common.repository')}</FieldLabel>
              {gitUrl ? (
                <Pressable
                  onPress={() => {
                    setGitUrl(null);
                  }}
                  hitSlop={8}
                  accessibilityRole="button"
                  className="active:opacity-70"
                >
                  <Text className="text-sm text-primary">{t('todos.lists.noRepository')}</Text>
                </Pressable>
              ) : null}
            </View>
            <RepoSelector
              value={todoListRepoSelection(gitUrl, repositories)}
              repositories={repositories}
              recents={recents}
              isLoading={groups.some(group => group.status === 'loading')}
              organizationId={organizationId}
              onChange={selection => {
                setGitUrl(todoListGitUrl(selection));
              }}
            />
          </View>

          <View className="flex-row items-center justify-between gap-3">
            <FieldLabel>{t('todos.listSettings.mode')}</FieldLabel>
            <ModeSelector
              value={normalizeAgentMode(mode ?? undefined)}
              onChange={next => {
                setMode(next);
              }}
            />
          </View>

          <View className="flex-row items-center justify-between gap-3">
            <FieldLabel>{t('common.model')}</FieldLabel>
            <View className="min-w-0 shrink">
              <ModelSelector
                value={model ?? ''}
                variant={variant ?? ''}
                options={models}
                isLoading={isLoadingModels}
                onSelect={(modelId, nextVariant) => {
                  setModel(modelId);
                  setVariant(nextVariant || null);
                }}
              />
            </View>
          </View>
          {saving ? <ActivityIndicator color={colors.mutedForeground} /> : null}
        </View>
      </PickerSheet>
      {dialog}
    </>
  );
}

/**
 * The list's name, emoji and session defaults, as a formSheet route so the
 * repository, mode and model pickers can stack above it. Without a `listId`
 * it creates a list in `organizationId`'s context.
 */
export function TodoListSettingsSheet({
  listId,
  organizationId,
}: Readonly<{ listId: string | null; organizationId: string | null }>) {
  const router = useRouter();
  const { t } = useTranslation();
  const lists = useTodoLists(organizationId, listId !== null);

  if (listId === null) {
    return <ListSettingsForm list={null} organizationId={organizationId} />;
  }
  const list = lists.data?.find(candidate => candidate.id === listId);
  if (list) {
    return <ListSettingsForm key={list.id} list={list} organizationId={organizationId} />;
  }
  return (
    <PickerSheet
      title={t('todos.listSettings.title')}
      onDone={() => {
        router.back();
      }}
      scrollable={false}
      expired={lists.isSuccess}
    >
      {lists.isError ? (
        <QueryError
          onRetry={() => void lists.refetch()}
          isRetrying={lists.isFetching}
          placement="top"
        />
      ) : (
        <View className="items-center py-8">
          <ActivityIndicator />
        </View>
      )}
    </PickerSheet>
  );
}
