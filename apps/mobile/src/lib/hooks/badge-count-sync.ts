import { type ListBadgesResponse } from '@kilocode/notifications';

type SetBadgeCount = (count: number) => Promise<boolean>;

export function totalUnreadCountFromBadges(badges: ListBadgesResponse): number {
  return badges.instances.reduce((total, row) => total + row.unreadCount, 0);
}

export async function syncDeviceBadgeCountFromBadges(
  badges: ListBadgesResponse,
  setBadgeCount: SetBadgeCount
): Promise<void> {
  await setBadgeCount(totalUnreadCountFromBadges(badges));
}
