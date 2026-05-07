let badgeFreshnessEpoch = 0;

export function readBadgeFreshnessEpoch(): number {
  return badgeFreshnessEpoch;
}

export function advanceBadgeFreshnessEpoch(): number {
  badgeFreshnessEpoch += 1;
  return badgeFreshnessEpoch;
}
