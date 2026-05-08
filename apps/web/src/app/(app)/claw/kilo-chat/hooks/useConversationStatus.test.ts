import { QueryClient } from '@tanstack/react-query';

import {
  conversationStatusKey,
  registerConversationStatusReconnectHandler,
} from './useConversationStatus';

function createFakeEventService() {
  let reconnectHandler: (() => void) | null = null;

  return {
    onReconnect: (handler: () => void) => {
      reconnectHandler = handler;
      return () => {
        reconnectHandler = null;
      };
    },
    emitReconnect: () => {
      reconnectHandler?.();
    },
  };
}

describe('useConversationStatus reconnect invalidation', () => {
  it('invalidates the active conversation status query on reconnect', () => {
    const queryClient = new QueryClient();
    const eventService = createFakeEventService();
    const activeKey = conversationStatusKey('01ARZ3NDEKTSV4RRFFQ69G5FAV');
    const otherKey = conversationStatusKey('01ARZ3NDEKTSV4RRFFQ69G5FAW');

    queryClient.setQueryData(activeKey, { conversationId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' });
    queryClient.setQueryData(otherKey, { conversationId: '01ARZ3NDEKTSV4RRFFQ69G5FAW' });

    registerConversationStatusReconnectHandler({
      conversationId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      eventService,
      queryClient,
    });

    eventService.emitReconnect();

    expect(queryClient.getQueryState(activeKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(otherKey)?.isInvalidated).toBe(false);
  });
});
