import { useKiloChat } from '../kilo-chat-provider';

export function useKiloChatClient() {
  return useKiloChat().kiloChatClient;
}
