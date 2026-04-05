'use client';

import { FIRST_TOPUP_BONUS_AMOUNT, PROMO_CREDIT_EXPIRY_HRS } from '@/lib/constants';
import { FirstTopup24for24CountdownTimer } from './FirstTopup24for24CountdownTimer';

export function FirstTopupBonusPromo() {
  return (
    <div className="mb-3 rounded-lg border border-blue-900 bg-linear-to-r from-blue-950 to-indigo-950 p-3">
      <div className="flex items-start gap-2">
        <div className="flex-1">
          <p className="text-sm font-semibold text-blue-100">
            🎉 Get ${FIRST_TOPUP_BONUS_AMOUNT()} Extra on Your First Top-Up
          </p>
          <p className="mt-1 text-sm text-blue-200">
            Top up any amount of credits and we&apos;ll add{' '}
            <span className="font-bold">${FIRST_TOPUP_BONUS_AMOUNT()}</span> on top of it,
            instantly.
          </p>
          <div className="mt-1 text-sm text-blue-200">
            <FirstTopup24for24CountdownTimer />
          </div>{' '}
          <p className="mt-1 text-xs text-blue-300">
            Free promotional credits expire in {Math.ceil(PROMO_CREDIT_EXPIRY_HRS / 24)} days.
          </p>
        </div>
      </div>
    </div>
  );
}
