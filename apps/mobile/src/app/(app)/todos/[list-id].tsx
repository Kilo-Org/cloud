import { type Href, useLocalSearchParams } from 'expo-router';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { TodoListScreen } from '@/components/todos/todo-list-screen';
import { useRetireCoveredSource } from '@/lib/navigation/retire-covered-source';
import { parseParam } from '@/lib/route-params';
import { TODO_AGENTS_TAB_ROUTE_NAME, TODO_LIST_SETTINGS_ROUTE_NAME } from '@/lib/todos/todo-routes';

export default function TodoListRoute() {
  const { 'list-id': rawListId } = useLocalSearchParams<{ 'list-id': string }>();
  const listId = parseParam(rawListId);
  // Creating a list pushes this screen and retires the settings sheet beneath
  // it from the sheet's own listener — which a covered screen never runs. This
  // side owns the retire instead: one reset that removes a `todos/list-settings`
  // entry directly beneath this list, with the Agents tab beneath the sheet.
  useRetireCoveredSource(TODO_LIST_SETTINGS_ROUTE_NAME, TODO_AGENTS_TAB_ROUTE_NAME);
  if (listId === null) {
    return <InvalidRouteState backTo={'/(app)/(tabs)/(2_agents)' as Href} />;
  }
  return <TodoListScreen listId={listId} />;
}
