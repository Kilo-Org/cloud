import { useMutation, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { browser, storage } from '#imports';
import {
  cancelDeviceAuthRequest,
  createDeviceAuthRequest,
  DeviceAuthHttpError,
  pollDeviceAuthCode,
} from '@/src/shared/auth';
import type { DeviceAuthRequest, FetchLike, StoredAuth } from '@/src/shared/auth';
import { persistApprovedDeviceAuth } from '@/src/shared/device-auth-approval';
import { describeFetchError } from './error-notice';
import type { DescribedFetchError } from './error-notice';

const pollIntervalMs = 3000;

export type { DescribedFetchError };

interface DeviceSignInOptions {
  readonly apiBaseUrl: string;
  readonly fetch: FetchLike;
  /** The approved request could not be stored, so no session exists. */
  readonly onApprovalLost: () => void;
  readonly onApproved: (auth: StoredAuth) => void;
  readonly reportError: (error: DescribedFetchError | null) => void;
  readonly reportMessage: (message: string | null) => void;
}

export interface DeviceSignIn {
  readonly cancelSignIn: () => void;
  readonly isStarting: boolean;
  readonly pendingAuthRequest: DeviceAuthRequest | undefined;
  readonly startSignIn: () => void;
}

const describeSignInError = (error: unknown): DescribedFetchError =>
  error instanceof DeviceAuthHttpError
    ? describeFetchError(error, error.status, error.body)
    : describeFetchError(error);

export const useDeviceSignIn = ({
  apiBaseUrl,
  fetch,
  onApprovalLost,
  onApproved,
  reportError,
  reportMessage,
}: DeviceSignInOptions): DeviceSignIn => {
  const [pendingAuthRequest, setPendingAuthRequest] = useState<DeviceAuthRequest | undefined>();

  const startSignIn = useMutation({
    mutationFn: () => createDeviceAuthRequest({ apiBaseUrl, fetch }),
    onError: (error: unknown) => {
      reportMessage(null);
      reportError(describeSignInError(error));
    },
    onSuccess: authRequest => {
      reportMessage(null);
      reportError(null);
      setPendingAuthRequest(authRequest);
      void browser.tabs.create({ url: authRequest.verificationUrl });
    },
  });

  const devicePollQuery = useQuery({
    enabled: pendingAuthRequest !== undefined,
    queryFn: ({ signal }) => {
      if (pendingAuthRequest === undefined) {
        return Promise.resolve({ status: 'pending' as const });
      }

      return pollDeviceAuthCode({
        apiBaseUrl,
        code: pendingAuthRequest.code,
        fetch,
        signal,
      });
    },
    queryKey: ['side-panel', 'device-auth', pendingAuthRequest?.code ?? 'idle'],
    refetchInterval: pendingAuthRequest === undefined ? false : pollIntervalMs,
  });

  useEffect(() => {
    const result = devicePollQuery.data;

    if (pendingAuthRequest === undefined || result === undefined || result.status === 'pending') {
      return;
    }

    if (result.status === 'approved') {
      void (async (): Promise<void> => {
        const persistence = await persistApprovedDeviceAuth(storage, result.auth);

        setPendingAuthRequest(undefined);
        if (persistence.status === 'failed') {
          reportMessage(persistence.message);
          onApprovalLost();
          return;
        }

        reportMessage(null);
        onApproved(persistence.auth);
      })();
      return;
    }

    setPendingAuthRequest(undefined);
    reportMessage(result.status === 'denied' ? 'Access was denied.' : 'Your sign-in code expired.');
    reportError(null);
  }, [
    devicePollQuery.data,
    onApprovalLost,
    onApproved,
    pendingAuthRequest,
    reportError,
    reportMessage,
  ]);

  useEffect(() => {
    if (devicePollQuery.isError) {
      setPendingAuthRequest(undefined);
      reportMessage('Sign in failed. Try again.');
    }
  }, [devicePollQuery.isError, reportMessage]);

  useEffect(() => {
    if (pendingAuthRequest === undefined) {
      return;
    }

    const expire = (): void => {
      setPendingAuthRequest(undefined);
      reportMessage('Your sign-in code expired.');
      reportError(null);
    };
    const remainingMs = pendingAuthRequest.expiresAt - Date.now();

    if (remainingMs <= 0) {
      expire();
      return;
    }

    const timer = setTimeout(expire, remainingMs);

    return () => {
      clearTimeout(timer);
    };
  }, [pendingAuthRequest, reportError, reportMessage]);

  const cancelSignIn = useCallback((): void => {
    const request = pendingAuthRequest;

    setPendingAuthRequest(undefined);
    reportMessage(null);
    reportError(null);

    if (request === undefined) {
      return;
    }

    /*
     * Cancel must end the request, not only the panel: the server marks it
     * denied so the approval page refuses it. A cancel that never arrives
     * leaves a request that expires on its own, so the user is told to close
     * the browser window instead.
     */
    void (async (): Promise<void> => {
      try {
        await cancelDeviceAuthRequest({ apiBaseUrl, code: request.code, fetch });
      } catch (error: unknown) {
        reportError({
          ...describeSignInError(error),
          detail: 'Close the browser window you opened so its code is not approved.',
        });
      }
    })();
  }, [apiBaseUrl, fetch, pendingAuthRequest, reportError, reportMessage]);

  return {
    cancelSignIn,
    isStarting: startSignIn.isPending,
    pendingAuthRequest,
    startSignIn: () => {
      startSignIn.mutate();
    },
  };
};
