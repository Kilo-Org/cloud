import { type PushData } from '@kilocode/notifications';

export function unreadCountsInvalidationKeyForNotification(
  userId: string | null,
  data: PushData | null
): readonly ['badges', string] | null {
  if (userId === null || data?.type !== 'chat.message') {
    return null;
  }
  return ['badges', userId] as const;
}
