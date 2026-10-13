import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, type TextInput, View } from 'react-native';

import { Plus } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { TODO_TITLE_MAX_LENGTH } from '@/lib/todos/todo-model';
import { cn } from '@/lib/utils';

/**
 * The add row at the top of a list. Submitting adds the to-do and clears the
 * field while the keyboard stays up, so several to-dos go in one after another.
 */
export function TodoQuickAdd({ onAdd }: Readonly<{ onAdd: (title: string) => void }>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const inputRef = useRef<TextInput>(null);
  const textRef = useRef('');
  const [hasText, setHasText] = useState(false);

  function submit() {
    const title = textRef.current.trim();
    if (title.length === 0) {
      return;
    }
    onAdd(title);
    textRef.current = '';
    setHasText(false);
    inputRef.current?.clear();
  }

  return (
    <View className="mx-4 my-2 flex-row items-center gap-2 rounded-lg border border-border bg-secondary pr-1">
      <Input
        ref={inputRef}
        placeholder={t('todos.list.addPlaceholder')}
        accessibilityLabel={t('todos.list.addPlaceholder')}
        onChangeText={text => {
          textRef.current = text;
          const next = text.trim().length > 0;
          setHasText(current => (current === next ? current : next));
        }}
        onSubmitEditing={submit}
        submitBehavior="submit"
        returnKeyType="done"
        maxLength={TODO_TITLE_MAX_LENGTH}
        className="min-w-0 flex-1 text-base text-foreground"
      />
      <Pressable
        onPress={submit}
        disabled={!hasText}
        accessibilityRole="button"
        accessibilityLabel={t('todos.list.add')}
        accessibilityState={{ disabled: !hasText }}
        className={cn(
          'size-9 items-center justify-center rounded-md active:opacity-70',
          hasText ? 'bg-primary' : 'bg-muted'
        )}
      >
        <Plus size={18} color={hasText ? colors.primaryForeground : colors.mutedForeground} />
      </Pressable>
    </View>
  );
}
