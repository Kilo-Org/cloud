import { useKiloChat } from '../KiloChatProvider';

export function useKiloChatClient() {
  return useKiloChat().kiloChatClient;
}
