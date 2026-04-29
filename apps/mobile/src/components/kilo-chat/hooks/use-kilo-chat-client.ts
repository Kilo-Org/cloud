import type { EventServiceClient } from '@kilocode/event-service';
import type { KiloChatClient } from '@kilocode/kilo-chat';

import { useKiloChatContext } from '../kilo-chat-provider';

/**
 * Returns the {@link KiloChatClient} instance from the nearest
 * {@link KiloChatProvider}. Throws if called outside a provider.
 */
export function useKiloChatClient(): KiloChatClient {
  return useKiloChatContext().kiloChatClient;
}

/**
 * Returns the {@link EventServiceClient} instance from the nearest
 * {@link KiloChatProvider}. Throws if called outside a provider.
 */
export function useEventServiceClient(): EventServiceClient {
  return useKiloChatContext().eventService;
}
