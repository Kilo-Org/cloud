import { useContext } from 'react';

import { KiloChatCurrentUserContext } from '../kilo-chat-provider';

export function useCurrentUserId(): string | null {
  return useContext(KiloChatCurrentUserContext);
}
