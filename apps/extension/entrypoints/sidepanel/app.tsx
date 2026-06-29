import { browser, storage } from '#imports';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import {
  clearStoredSession,
  createDeviceAuthRequest,
  getKiloApiBaseUrl,
  loadStoredAuth,
  pollDeviceAuthCode,
  saveStoredAuth,
  validateAuthToken,
} from '@/src/shared/auth';
import type { DeviceAuthRequest, FetchLike, StoredAuth } from '@/src/shared/auth';
import { persistApprovedDeviceAuth } from '@/src/shared/device-auth-approval';
import { getAuthValidationQueryKey } from '@/src/shared/side-panel-query-options';
import {
  LoadingView,
  PendingView,
  SignedInView,
  SignedOutView,
  ValidationErrorView,
} from './auth-views';
import { clearPerConversationAtoms } from './agent-chat-atoms';

const pollIntervalMs = 3000;
const apiBaseUrl = getKiloApiBaseUrl();
const fetchFromWindow: FetchLike = (input, init) => fetch(input, init);
const storedAuthQueryKey = ['side-panel', 'stored-auth'] as const;

type AuthValidationData =
  | {
      readonly auth: StoredAuth;
      readonly status: 'signedIn';
    }
  | {
      readonly message?: string;
      readonly status: 'signedOut';
    }
  | {
      readonly status: 'validationError';
    };

export const App = (): JSX.Element => {
  const queryClient = useQueryClient();
  const [pendingAuthRequest, setPendingAuthRequest] = useState<DeviceAuthRequest | undefined>();
  const [signedOutMessage, setSignedOutMessage] = useState<string | undefined>();
  const {
    data: storedAuth,
    isLoading: isStoredAuthLoading,
    isSuccess: isStoredAuthSuccess,
    refetch: refetchStoredAuth,
  } = useQuery({
    /*
     * React Query forbids a queryFn resolving to undefined. Return null for the
     * signed-out state and map it back to undefined for the UI via select.
     */
    queryFn: async () => (await loadStoredAuth(storage)) ?? null,
    queryKey: storedAuthQueryKey,
    select: data => data ?? undefined,
  });
  const {
    data: authValidationData,
    isError: isAuthValidationError,
    isLoading: isAuthValidationLoading,
    refetch: refetchAuthValidation,
  } = useQuery({
    // Skip validation with no token; a message-less signedOut would clobber the expiry message.
    enabled: isStoredAuthSuccess && storedAuth !== undefined,
    queryFn: async ({ signal }): Promise<AuthValidationData> => {
      if (storedAuth === undefined) {
        return { status: 'signedOut' };
      }

      const result = await validateAuthToken({
        apiBaseUrl,
        fetch: fetchFromWindow,
        signal,
        token: storedAuth.token,
      });

      if (result.status === 'valid') {
        await saveStoredAuth(storage, result.auth);
        return { auth: result.auth, status: 'signedIn' };
      }

      if (result.status === 'invalid') {
        // Clear all account-scoped state (conversations included) like sign-out so a later account on this profile never loads the expired user's data. Message returned below.
        await clearStoredSession(storage);
        clearPerConversationAtoms();
        return { message: 'Your session expired. Sign in again.', status: 'signedOut' };
      }

      return { status: 'validationError' };
    },
    queryKey:
      storedAuth === undefined
        ? getAuthValidationQueryKey('none')
        : getAuthValidationQueryKey(storedAuth.token),
  });
  const startSignIn = useMutation({
    mutationFn: () =>
      createDeviceAuthRequest({
        apiBaseUrl,
        fetch: fetchFromWindow,
      }),
    onError: () => {
      setSignedOutMessage('Failed to start sign in. Try again.');
    },
    onSuccess: authRequest => {
      setSignedOutMessage(undefined);
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
        fetch: fetchFromWindow,
        signal,
      });
    },
    queryKey: ['side-panel', 'device-auth', pendingAuthRequest?.code ?? 'idle'],
    refetchInterval: pendingAuthRequest === undefined ? false : pollIntervalMs,
  });

  useEffect(() => {
    if (authValidationData?.status === 'signedOut') {
      setSignedOutMessage(authValidationData.message);
      queryClient.setQueryData(storedAuthQueryKey, undefined);
    }
  }, [authValidationData, queryClient]);

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
          setSignedOutMessage(persistence.message);
          queryClient.setQueryData(storedAuthQueryKey, undefined);
          return;
        }

        setSignedOutMessage(undefined);
        queryClient.setQueryData(storedAuthQueryKey, persistence.auth);
        queryClient.setQueryData(getAuthValidationQueryKey(persistence.auth.token), {
          auth: persistence.auth,
          status: 'signedIn',
        } satisfies AuthValidationData);
      })();
      return;
    }

    setPendingAuthRequest(undefined);
    setSignedOutMessage(
      result.status === 'denied' ? 'Access was denied.' : 'Your sign-in code expired.'
    );
  }, [devicePollQuery.data, pendingAuthRequest, queryClient]);

  useEffect(() => {
    if (devicePollQuery.isError) {
      setPendingAuthRequest(undefined);
      setSignedOutMessage('Sign in failed. Try again.');
    }
  }, [devicePollQuery.isError]);

  const cancelSignIn = useCallback((): void => {
    setPendingAuthRequest(undefined);
  }, []);

  const signOut = useCallback((): void => {
    setPendingAuthRequest(undefined);
    setSignedOutMessage(undefined);
    void (async (): Promise<void> => {
      try {
        await clearStoredSession(storage);
      } finally {
        clearPerConversationAtoms();
        queryClient.setQueryData(storedAuthQueryKey, undefined);
        if (storedAuth !== undefined) {
          queryClient.setQueryData(getAuthValidationQueryKey(storedAuth.token), {
            status: 'signedOut',
          } satisfies AuthValidationData);
        }
      }
    })();
  }, [queryClient, storedAuth]);

  const retrySessionCheck = useCallback((): void => {
    if (storedAuth === undefined) {
      void refetchStoredAuth();
      return;
    }

    void refetchAuthValidation();
  }, [refetchAuthValidation, refetchStoredAuth, storedAuth]);

  if (isStoredAuthLoading || isAuthValidationLoading) {
    return <LoadingView />;
  }

  if (startSignIn.isPending) {
    return (
      <SignedOutView
        isStarting
        message={signedOutMessage}
        onSignIn={() => {
          startSignIn.mutate();
        }}
      />
    );
  }

  if (pendingAuthRequest !== undefined) {
    return (
      <PendingView
        code={pendingAuthRequest.code}
        onCancel={cancelSignIn}
        onOpen={() => {
          void browser.tabs.create({ url: pendingAuthRequest.verificationUrl });
        }}
      />
    );
  }

  if (authValidationData?.status === 'validationError' || isAuthValidationError) {
    return (
      <ValidationErrorView
        onRetry={retrySessionCheck}
        onSignInAgain={() => {
          startSignIn.mutate();
        }}
      />
    );
  }

  if (authValidationData?.status === 'signedIn') {
    return <SignedInView auth={authValidationData.auth} onSignOut={signOut} />;
  }

  return (
    <SignedOutView
      isStarting={false}
      message={signedOutMessage}
      onSignIn={() => {
        startSignIn.mutate();
      }}
    />
  );
};
