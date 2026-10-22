import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type TextInput, View } from 'react-native';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Button } from '@/components/ui/button';
import { Plus } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { TODO_TITLE_MAX_LENGTH } from '@/lib/todos/todo-model';

/**
 * The add row at the top of a list. Submitting adds the to-do and clears the
 * field once the add is confirmed, so a failed add keeps the typed title in
 * place with its error while several to-dos go in one after another.
 */
export function TodoQuickAdd({ onAdd }: Readonly<{ onAdd: (title: string) => Promise<void> }>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const inputRef = useRef<TextInput>(null);
  const textRef = useRef('');
  const addingRef = useRef(false);
  const [hasText, setHasText] = useState(false);
  const [adding, setAdding] = useState(false);
  const [failed, setFailed] = useState(false);

  async function submit() {
    const title = textRef.current.trim();
    if (title.length === 0 || addingRef.current) {
      return;
    }
    addingRef.current = true;
    setAdding(true);
    setFailed(false);
    try {
      await onAdd(title);
      textRef.current = '';
      setHasText(false);
      inputRef.current?.clear();
    } catch {
      // The title stays in the field, so the row's status line below is the
      // only report the retry needs.
      setFailed(true);
    } finally {
      addingRef.current = false;
      setAdding(false);
    }
  }

  return (
    <View className="mx-4 my-2 gap-1">
      <View className="flex-row items-center gap-2 rounded-lg border border-border bg-secondary pr-1">
        <Input
          ref={inputRef}
          placeholder={t('todos.list.addPlaceholder')}
          accessibilityLabel={t('todos.list.addPlaceholder')}
          onChangeText={text => {
            textRef.current = text;
            const next = text.trim().length > 0;
            setHasText(current => (current === next ? current : next));
          }}
          onSubmitEditing={() => {
            void submit();
          }}
          submitBehavior="submit"
          returnKeyType="done"
          maxLength={TODO_TITLE_MAX_LENGTH}
          className="min-w-0 flex-1 text-base text-foreground"
        />
        <Button
          size="sm"
          disabled={!hasText || adding}
          onPress={() => {
            void submit();
          }}
          accessibilityLabel={t('todos.list.add')}
        >
          <Plus size={16} color={colors.primaryForeground} />
          <Text>{t('todos.list.add')}</Text>
        </Button>
      </View>
      <AccessibleStatus
        message={failed ? t('todos.list.addFailed') : null}
        className="px-1 text-sm"
      />
    </View>
  );
}
