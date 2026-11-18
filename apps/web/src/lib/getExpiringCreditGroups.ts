type CreditBlock = {
  expiry_date: string | null;
  balance_mUsd: number;
};

export function getExpiringCreditGroups(creditBlocks: readonly CreditBlock[]) {
  const balancesByExpiry = new Map<string, number>();

  for (const block of creditBlocks) {
    if (block.expiry_date === null || block.balance_mUsd <= 0) continue;

    const expiry_date = new Date(block.expiry_date).toISOString();
    balancesByExpiry.set(
      expiry_date,
      (balancesByExpiry.get(expiry_date) ?? 0) + block.balance_mUsd
    );
  }

  return [...balancesByExpiry]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([expiry_date, balance_mUsd]) => ({ expiry_date, balance_mUsd }));
}
