export type IssuanceWindow = {
  start: Date;
  end: Date;
};

export type AllocationValidation =
  | { valid: true; directChildCapacity: number; parentDefaultCapacity: number }
  | { valid: false; reason: 'negative_capacity' | 'overallocated' };

export function validateAllocation(
  purchasedPassCapacity: number,
  directChildCapacities: readonly number[]
): AllocationValidation {
  if (
    !Number.isSafeInteger(purchasedPassCapacity) ||
    purchasedPassCapacity < 0 ||
    directChildCapacities.some(capacity => !Number.isSafeInteger(capacity) || capacity < 0)
  ) {
    return { valid: false, reason: 'negative_capacity' };
  }

  const directChildCapacity = directChildCapacities.reduce(
    (total, capacity) => total + capacity,
    0
  );
  if (!Number.isSafeInteger(directChildCapacity)) {
    throw new Error('total direct-child capacity must be a safe integer');
  }
  if (directChildCapacity > purchasedPassCapacity) {
    return { valid: false, reason: 'overallocated' };
  }

  return {
    valid: true,
    directChildCapacity,
    parentDefaultCapacity: purchasedPassCapacity - directChildCapacity,
  };
}

export function monthlyWindowFromOriginalAnchor(anchor: Date, monthIndex: number): IssuanceWindow {
  if (!Number.isInteger(monthIndex) || monthIndex < 0) {
    throw new Error('monthIndex must be a non-negative integer');
  }

  const start = monthlyBoundaryFromOriginalAnchor(anchor, monthIndex);
  const end = monthlyBoundaryFromOriginalAnchor(anchor, monthIndex + 1);
  return { start, end };
}

export function monthlyWindowContaining(anchor: Date, date: Date): IssuanceWindow {
  let monthIndex = Math.max(
    0,
    (date.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
      date.getUTCMonth() -
      anchor.getUTCMonth()
  );
  let window = monthlyWindowFromOriginalAnchor(anchor, monthIndex);
  while (window.start > date && monthIndex > 0) {
    monthIndex -= 1;
    window = monthlyWindowFromOriginalAnchor(anchor, monthIndex);
  }
  while (window.end <= date) {
    monthIndex += 1;
    window = monthlyWindowFromOriginalAnchor(anchor, monthIndex);
  }
  return window;
}

function monthlyBoundaryFromOriginalAnchor(anchor: Date, monthIndex: number): Date {
  const targetMonth = anchor.getUTCMonth() + monthIndex;
  const targetYear = anchor.getUTCFullYear() + Math.floor(targetMonth / 12);
  const targetMonthOfYear = targetMonth % 12;
  const targetDay = Math.min(anchor.getUTCDate(), daysInUtcMonth(targetYear, targetMonthOfYear));
  return new Date(
    Date.UTC(
      targetYear,
      targetMonthOfYear,
      targetDay,
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds()
    )
  );
}

function daysInUtcMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

export function isWindowCoveredByPaidThrough(
  window: IssuanceWindow,
  paidThrough: { start: Date; end: Date }
): boolean {
  return paidThrough.start <= window.start && paidThrough.end >= window.end;
}

export function bridgeRatio(
  window: IssuanceWindow,
  paidThrough: { start: Date; end: Date }
): {
  numerator: number;
  denominator: number;
} {
  const denominator = window.end.getTime() - window.start.getTime();
  if (denominator <= 0) {
    throw new Error('window must have a positive duration');
  }

  const serviceStart = Math.max(window.start.getTime(), paidThrough.start.getTime());
  const serviceEnd = Math.min(window.end.getTime(), paidThrough.end.getTime());
  const numerator = Math.max(0, serviceEnd - serviceStart);
  return { numerator, denominator };
}

export function roundHalfUpMicrodollars(
  value: number,
  numerator: number,
  denominator: number
): number {
  if (
    !Number.isSafeInteger(value) ||
    !Number.isSafeInteger(numerator) ||
    !Number.isSafeInteger(denominator)
  ) {
    throw new Error('microdollar calculation inputs must be safe integers');
  }
  if (value < 0 || numerator < 0 || denominator <= 0 || numerator > denominator) {
    throw new Error('invalid microdollar ratio');
  }

  const rounded =
    (BigInt(value) * BigInt(numerator) + BigInt(Math.floor(denominator / 2))) / BigInt(denominator);
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('rounded microdollar amount exceeds safe integer range');
  }
  return Number(rounded);
}
