import { useLocalSearchParams } from 'expo-router';

import { TodoListSettingsSheet } from '@/components/todos/todo-list-settings-sheet';
import { parseParam } from '@/lib/route-params';

export default function TodoListSettingsRoute() {
  const { listId, organizationId, afterCreate } = useLocalSearchParams<{
    listId?: string;
    organizationId?: string;
    afterCreate?: string;
  }>();
  return (
    <TodoListSettingsSheet
      listId={parseParam(listId)}
      organizationId={parseParam(organizationId)}
      afterCreate={parseParam(afterCreate, ['back'] as const) ?? 'open'}
    />
  );
}
