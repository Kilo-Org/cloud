import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { SegmentedControl } from '@/components/ui/segmented-control';

export type AgentsView = 'sessions' | 'todos';

/** The Agents tab's switch between its sessions and its to-do lists. */
export function AgentsViewSegment({
  value,
  onChange,
}: Readonly<{ value: AgentsView; onChange: (view: AgentsView) => void }>) {
  const { t } = useTranslation();
  return (
    <View className="px-4 pb-2">
      <SegmentedControl<AgentsView>
        accessibilityLabel={t('todos.segment.label')}
        options={[
          { value: 'sessions', label: t('todos.segment.sessions') },
          { value: 'todos', label: t('todos.segment.todos') },
        ]}
        value={value}
        onChange={onChange}
      />
    </View>
  );
}
