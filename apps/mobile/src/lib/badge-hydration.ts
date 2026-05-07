import { type BadgeCountRow } from '@kilocode/notifications';

type ReconcileHydratedBadgeCountInput = {
  badgeRows: BadgeCountRow[];
  startBadgeFreshnessEpoch: number;
  currentBadgeFreshnessEpoch: number;
  setBadgeCount: (badgeCount: number) => Promise<unknown>;
};

export function totalBadgeCount(badgeRows: BadgeCountRow[]): number {
  return badgeRows.reduce((total, row) => total + row.badgeCount, 0);
}

export function reconcileHydratedBadgeCount({
  badgeRows,
  startBadgeFreshnessEpoch,
  currentBadgeFreshnessEpoch,
  setBadgeCount,
}: ReconcileHydratedBadgeCountInput): boolean {
  if (currentBadgeFreshnessEpoch !== startBadgeFreshnessEpoch) {
    return false;
  }

  void setBadgeCount(totalBadgeCount(badgeRows));
  return true;
}
