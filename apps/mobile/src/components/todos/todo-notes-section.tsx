import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, TextInput, View } from 'react-native';

import { MarkdownText } from '@/components/agents/markdown-text';
import { SectionHeader } from '@/components/home/section-header';
import { Text } from '@/components/ui/text';
import { useTodoItemMutations } from '@/lib/hooks/use-todos';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { TODO_NOTES_MAX_LENGTH } from '@/lib/todos/todo-model';
import { type TodoItemDetail } from '@/lib/todos/todo-types';

/** The editor: the purpose prompt as placeholder, Markdown support as optional help beside it. */
function TodoNotesEditor({
  notesRef,
  onSave,
}: Readonly<{
  notesRef: { current: string };
  onSave: () => void;
}>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  return (
    <View className="gap-1.5">
      <TextInput
        autoFocus
        multiline
        defaultValue={notesRef.current}
        onChangeText={text => {
          notesRef.current = text;
        }}
        onEndEditing={onSave}
        maxLength={TODO_NOTES_MAX_LENGTH}
        accessibilityLabel={t('todos.item.notes')}
        placeholder={t('todos.item.notesPrompt')}
        placeholderTextColor={colors.mutedForeground}
        className="min-h-32 rounded-lg border border-border bg-secondary pb-2.5 pl-3 pr-3 pt-2.5 text-base leading-6 text-foreground"
      />
      <Text className="text-xs text-ink2">{t('todos.item.markdownSupported')}</Text>
    </View>
  );
}

/** The rest view: rendered notes, or a purpose-focused prompt when there are none. */
function TodoNotesBody({
  hasNotes,
  notes,
  onEdit,
}: Readonly<{ hasNotes: boolean; notes: string; onEdit: () => void }>) {
  const { t } = useTranslation();
  if (hasNotes) {
    return (
      <Pressable
        onPress={onEdit}
        accessibilityRole="button"
        accessibilityHint={t('chat.messageActions.edit')}
      >
        <MarkdownText value={notes} />
      </Pressable>
    );
  }
  return (
    <Pressable
      onPress={onEdit}
      accessibilityRole="button"
      className="min-h-11 justify-center py-1 active:opacity-70"
    >
      <Text className="text-sm text-ink2">{t('todos.item.notesPrompt')}</Text>
    </Pressable>
  );
}

/** The Markdown notes under the task title: purpose-focused when empty, Edit when present. */
export function TodoNotesSection({ todo }: Readonly<{ todo: TodoItemDetail }>) {
  const { t } = useTranslation();
  const { update } = useTodoItemMutations(todo.listId);
  const notesRef = useRef(todo.notes ?? '');
  const [editing, setEditing] = useState(false);
  const savedNotes = (todo.notes ?? '').trim();
  const hasNotes = savedNotes.length > 0;

  function saveNotes() {
    setEditing(false);
    const notes = notesRef.current.trim();
    if (notes === savedNotes) {
      return;
    }
    update.mutate({ id: todo.id, notes: notes.length > 0 ? notes : null });
  }

  let actionLabel = t('todos.item.addNotes');
  if (editing) {
    actionLabel = t('common.done');
  } else if (hasNotes) {
    actionLabel = t('chat.messageActions.edit');
  }

  return (
    <View>
      <SectionHeader
        label={t('todos.item.notes')}
        actionLabel={actionLabel}
        onActionPress={() => {
          if (editing) {
            saveNotes();
          } else {
            setEditing(true);
          }
        }}
      />
      <View className="px-4">
        {editing ? (
          <TodoNotesEditor notesRef={notesRef} onSave={saveNotes} />
        ) : (
          <TodoNotesBody
            hasNotes={hasNotes}
            notes={todo.notes ?? ''}
            onEdit={() => {
              setEditing(true);
            }}
          />
        )}
      </View>
    </View>
  );
}
