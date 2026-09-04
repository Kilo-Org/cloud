import { useCallback, useEffect, useRef, useState } from 'react';
import { type NativeTokenPair } from '@kilocode/app-shared/native-auth';

import { clearLoginDrafts } from '@/lib/login-draft';

type DeviceApprovalPersistenceOptions = {
  status: string;
  credentials: NativeTokenPair | undefined;
  signIn: (pair: NativeTokenPair) => Promise<boolean>;
  couldNotCompleteSignIn: string;
};

type DeviceApprovalPersistence = {
  persistError: string | undefined;
  isPersisting: boolean;
  persistToken: (pair: NativeTokenPair) => Promise<void>;
};

export function useDeviceApprovalPersistence({
  status,
  credentials,
  signIn,
  couldNotCompleteSignIn,
}: DeviceApprovalPersistenceOptions): DeviceApprovalPersistence {
  const [persistError, setPersistError] = useState<string | undefined>(undefined);
  const [isPersisting, setIsPersisting] = useState(false);
  const attemptedCredentials = useRef<NativeTokenPair | undefined>(undefined);
  const isPersistingRef = useRef(false);
  const activeCredentials = useRef<NativeTokenPair | undefined>(undefined);
  const pendingCredentials = useRef<NativeTokenPair | undefined>(undefined);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  const persistToken = useCallback(
    async (pair: NativeTokenPair) => {
      if (isPersistingRef.current) {
        // Preserve the newest credentials received from device approval while
        // the current auth transition finishes. Repeating the active pair is
        // a rapid Retry and must not enqueue a duplicate transition.
        if (activeCredentials.current !== pair) {
          pendingCredentials.current = pair;
        }
        return;
      }
      isPersistingRef.current = true;
      activeCredentials.current = pair;
      attemptedCredentials.current = pair;
      setIsPersisting(true);
      setPersistError(undefined);
      try {
        const persistLatest = async (nextCredentials: NativeTokenPair): Promise<boolean> => {
          activeCredentials.current = nextCredentials;
          attemptedCredentials.current = nextCredentials;
          let didPersist = false;
          try {
            didPersist = await signIn(nextCredentials);
          } catch {
            didPersist = false;
          }

          const pending = pendingCredentials.current;
          pendingCredentials.current = undefined;
          return pending ? persistLatest(pending) : didPersist;
        };
        const didPersist = await persistLatest(pair);

        if (didPersist) {
          clearLoginDrafts();
        } else if (isMounted.current) {
          setPersistError(couldNotCompleteSignIn);
        }
      } finally {
        isPersistingRef.current = false;
        activeCredentials.current = undefined;
        if (isMounted.current) {
          setIsPersisting(false);
        }
      }
    },
    [couldNotCompleteSignIn, signIn]
  );

  useEffect(() => {
    if (status !== 'approved' || !credentials) {
      attemptedCredentials.current = undefined;
      return;
    }
    if (attemptedCredentials.current === credentials) {
      return;
    }
    attemptedCredentials.current = credentials;
    void persistToken(credentials);
  }, [credentials, persistToken, status]);

  return { persistError, isPersisting, persistToken };
}
