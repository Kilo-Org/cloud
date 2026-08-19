import { type BadgeCountRow } from '@kilocode/notifications';

type ReconcileHydratedBadgeCountInput<TSetBadgeCountResult> = {
  badgeRows: BadgeCountRow[];
  startBadgeFreshnessEpoch: number;
  currentBadgeFreshnessEpoch: number;
  setBadgeCount: (badgeCount: number) => Promise<TSetBadgeCountResult>;
};

export function totalBadgeCount(badgeRows: BadgeCountRow[]): number {
  return badgeRows.reduce((total, row) => total + row.badgeCount, 0);
}

export function reconcileHydratedBadgeCount<TSetBadgeCountResult>({
  badgeRows,
  startBadgeFreshnessEpoch,
  currentBadgeFreshnessEpoch,
  setBadgeCount,
}: ReconcileHydratedBadgeCountInput<TSetBadgeCountResult>): boolean {
  if (currentBadgeFreshnessEpoch !== startBadgeFreshnessEpoch) {
    return false;
  }

  void setBadgeCount(totalBadgeCount(badgeRows));
  return true;
}
