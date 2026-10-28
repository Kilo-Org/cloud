import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

export type AgentsView = 'sessions' | 'todos';

export function AgentsViewSegment({
  value,
  onChange,
}: Readonly<{ value: AgentsView; onChange: (view: AgentsView) => void }>) {
  const { t } = useTranslation();
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={t('todos.segment.label')}
      className="min-w-0 flex-1 flex-row gap-4"
    >
      {(['sessions', 'todos'] as const).map(view => (
        <Pressable
          key={view}
          // `tab` carries no iOS accessibility trait in React Native, so the
          // entry would read as static text; `button` makes it a control and
          // `selected` still marks the active view.
          accessibilityRole="button"
          accessibilityState={{ selected: value === view }}
          onPress={() => {
            if (value !== view) {
              onChange(view);
            }
          }}
          className={cn(
            'min-h-[48px] min-w-[48px] shrink justify-center border-b-2 active:opacity-70',
            value === view ? 'border-foreground' : 'border-transparent'
          )}
        >
          <Text
            className={cn(
              'text-center text-sm',
              value === view ? 'font-semibold text-foreground' : 'text-muted-foreground'
            )}
          >
            {view === 'sessions' ? t('todos.segment.sessions') : t('todos.segment.todos')}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
