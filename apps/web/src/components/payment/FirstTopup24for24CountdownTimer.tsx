'use client';

import { deadline_XL_first_topup_bonus, is_XL_first_topup_bonus_active } from '@/lib/constants';
import { formatDuration, intervalToDuration } from 'date-fns';
import { useEffect, useState } from 'react';

export function FirstTopup24for24CountdownTimer() {
  const [timeRemaining, setTimeRemaining] = useState<string>('');

  useEffect(() => {
    let timeoutId: NodeJS.Timeout | null = null;

    const updateTimeRemaining = () => {
      const now = Date.now();
      const duration = intervalToDuration({
        start: now,
        end: deadline_XL_first_topup_bonus,
      });
      setTimeRemaining(formatDuration(duration, { zero: true }));
      timeoutId = setTimeout(updateTimeRemaining, 1001 - (now % 1000));
    };

    updateTimeRemaining();

    return () => {
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, []);

  return is_XL_first_topup_bonus_active() ? (
    <>This enhanced offer expires in {timeRemaining}</>
  ) : null;
}
