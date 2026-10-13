import { type Href, useLocalSearchParams } from 'expo-router';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { TodoDetailScreen } from '@/components/todos/todo-detail-screen';
import { parseParam } from '@/lib/route-params';

export default function TodoDetailRoute() {
  const { 'item-id': rawItemId } = useLocalSearchParams<{ 'item-id': string }>();
  const itemId = parseParam(rawItemId);
  if (itemId === null) {
    return <InvalidRouteState backTo={'/(app)/(tabs)/(2_agents)' as Href} />;
  }
  return <TodoDetailScreen itemId={itemId} />;
}
