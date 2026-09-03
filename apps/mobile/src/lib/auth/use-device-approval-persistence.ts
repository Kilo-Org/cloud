import { useCallback, useEffect, useRef, useState } from 'react';
import { type NativeTokenPair } from '@kilocode/app-shared/native-auth';

import { clearLoginDrafts } from '@/lib/login-draft';

type DeviceApprovalPersistenceOptions = {
  status: string;
  credentials: NativeTokenPair | undefined;
  signIn: (pair: NativeTokenPair) => Promise<void>;
  couldNotCompleteSignIn: string;
};

type DeviceApprovalPersistence = {
  persistError: string | undefined;
  persistToken: (pair: NativeTokenPair) => Promise<void>;
};

export function useDeviceApprovalPersistence({
  status,
  credentials,
  signIn,
  couldNotCompleteSignIn,
}: DeviceApprovalPersistenceOptions): DeviceApprovalPersistence {
  const [persistError, setPersistError] = useState<string | undefined>(undefined);
  const attemptedCredentials = useRef<NativeTokenPair | undefined>(undefined);
  const persistToken = useCallback(
    async (pair: NativeTokenPair) => {
      setPersistError(undefined);
      try {
        await signIn(pair);
        clearLoginDrafts();
      } catch {
        setPersistError(couldNotCompleteSignIn);
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

  return { persistError, persistToken };
}
