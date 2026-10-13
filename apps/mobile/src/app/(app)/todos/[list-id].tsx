import { type Href, useLocalSearchParams } from 'expo-router';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { TodoListScreen } from '@/components/todos/todo-list-screen';
import { parseParam } from '@/lib/route-params';

export default function TodoListRoute() {
  const { 'list-id': rawListId } = useLocalSearchParams<{ 'list-id': string }>();
  const listId = parseParam(rawListId);
  if (listId === null) {
    return <InvalidRouteState backTo={'/(app)/(tabs)/(2_agents)' as Href} />;
  }
  return <TodoListScreen listId={listId} />;
}
