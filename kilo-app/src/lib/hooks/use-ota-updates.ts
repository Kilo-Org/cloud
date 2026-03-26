import * as Updates from 'expo-updates';
import { useEffect, useRef, useState } from 'react';

type OTAStatus = 'idle' | 'checking' | 'downloading' | 'ready';

export function useOTAUpdates(forceUpdate: boolean) {
  const [status, setStatus] = useState<OTAStatus>('idle');
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!Updates.isEnabled) {
      return undefined;
    }

    cancelledRef.current = false;

    async function checkAndApply(): Promise<void> {
      try {
        setStatus('checking');
        const update = await Updates.checkForUpdateAsync();

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!cancelledRef.current && update.isAvailable) {
          setStatus('downloading');
          await Updates.fetchUpdateAsync();

          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          if (!cancelledRef.current) {
            if (forceUpdate) {
              setStatus('ready');
              await Updates.reloadAsync();
            } else {
              // Background mode: update downloaded, will apply on next launch
              setStatus('idle');
            }
          }
        } else if (!cancelledRef.current) {
          setStatus('idle');
        }
      } catch {
        // OTA check failed — fail open, don't block the app
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!cancelledRef.current) {
          setStatus('idle');
        }
      }
    }

    void checkAndApply();

    // eslint-disable-next-line @typescript-eslint/consistent-return
    return (): void => {
      cancelledRef.current = true;
    };
  }, [forceUpdate]);

  // When forceUpdate is true, block until check completes
  const isBlocking = forceUpdate && (status === 'checking' || status === 'downloading');

  return { status, isBlocking };
}
