import { useLocalSearchParams } from 'expo-router';

import { TodoListSettingsSheet } from '@/components/todos/todo-list-settings-sheet';
import { parseParam } from '@/lib/route-params';

export default function TodoListSettingsRoute() {
  const { listId, organizationId } = useLocalSearchParams<{
    listId?: string;
    organizationId?: string;
  }>();
  return (
    <TodoListSettingsSheet
      listId={parseParam(listId)}
      organizationId={parseParam(organizationId)}
    />
  );
}
