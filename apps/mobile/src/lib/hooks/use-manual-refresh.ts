import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { announceForA11y } from '@/lib/a11y/announce';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { useMotionPolicy } from '@/lib/a11y/motion';

// Wraps a pull-to-refresh refetch with a "refreshing" flag and a toast on
// failure. Callers with multiple queries to refetch should reduce their
// results into a single `{ isError }` before passing `refetch` in.
//
// Under reduced motion the platform's pull indicator is inert, so the same pull
// announces its start and its finish for a screen reader instead (the screen's
// static `RefreshProgress` band carries the visible half). A pull that arrives
// while one is already running is ignored. A read that settles after the
// calling screen unmounted announces nothing and writes no state.
export function useManualRefresh(
  refetch: () => Promise<{ isError: boolean }>,
  errorMessage: string
): [boolean, () => void] {
  const { t } = useTranslation();
  const { reducedMotion } = useMotionPolicy();
  const [refreshing, setRefreshing] = useState(false);
  // False until the mount commits, so a caller that leaves inside its own mount
  // window still reads as unmounted.
  const mountedRef = useRef(false);
  // Set for the whole life of one pull, so a second gesture cannot start a
  // second read over the same flag.
  const inFlightRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const onRefresh = useCallback(() => {
    if (!mountedRef.current) {
      return;
    }
    if (inFlightRef.current) {
      // A gesture that arrives while a read is running would otherwise restart
      // the same read and re-announce its start.
      return;
    }
    inFlightRef.current = true;
    if (reducedMotion) {
      // Announced when the pull is admitted, before the await, so the reader
      // hears that the gesture was taken even when the read is slow.
      announceForA11y(t('common.loading'));
    }
    void (async () => {
      setRefreshing(true);
      try {
        const result = await refetch();
        if (!mountedRef.current) {
          return;
        }
        if (result.isError) {
          announcingToast.error(errorMessage);
        } else if (reducedMotion) {
          announceForA11y(t('common.updated'));
        }
      } finally {
        inFlightRef.current = false;
        if (mountedRef.current) {
          setRefreshing(false);
        }
      }
    })();
  }, [refetch, errorMessage, reducedMotion, t]);

  return [refreshing, onRefresh];
}
