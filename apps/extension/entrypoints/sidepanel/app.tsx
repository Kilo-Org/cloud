import { browser, storage } from '#imports';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import {
  clearStoredAuth,
  createDeviceAuthRequest,
  getKiloApiBaseUrl,
  loadStoredAuth,
  pollDeviceAuthCode,
  saveStoredAuth,
  validateAuthToken,
} from '@/src/shared/auth';
import type { FetchLike, StoredAuth } from '@/src/shared/auth';
import {
  LoadingView,
  PendingView,
  SignedInView,
  SignedOutView,
  ValidationErrorView,
} from './auth-views';
import { useTabDebugger } from './use-tab-debugger';

const pollIntervalMs = 3000;
const apiBaseUrl = getKiloApiBaseUrl();
const fetchFromWindow: FetchLike = (input, init) => fetch(input, init);

type PanelState =
  | {
      readonly message?: string;
      readonly status: 'checking' | 'signedOut' | 'starting';
    }
  | {
      readonly code: string;
      readonly status: 'pending';
      readonly verificationUrl: string;
    }
  | {
      readonly auth: StoredAuth;
      readonly status: 'signedIn';
    }
  | {
      readonly status: 'validationError';
    };

export const App = (): JSX.Element => {
  const [state, setState] = useState<PanelState>({ status: 'checking' });
  const {
    htmlLength,
    inspectableTabs,
    isLoadingTabs,
    isMeasuringHtml,
    loadInspectableTabs,
    measureSelectedTabHtml,
    selectTab,
    selectedTabId,
    tabDebuggerError,
  } = useTabDebugger();
  const abortRef = useRef<AbortController | null>(null);
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopPolling = useCallback((): void => {
    if (pollTimeoutRef.current !== null) {
      clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = null;
    }

    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const validateStoredAuth = useCallback(async (): Promise<void> => {
    stopPolling();
    setState({ status: 'checking' });

    const storedAuth = await loadStoredAuth(storage);
    if (!storedAuth) {
      setState({ status: 'signedOut' });
      return;
    }

    const abort = new AbortController();
    abortRef.current = abort;
    const result = await validateAuthToken({
      apiBaseUrl,
      fetch: fetchFromWindow,
      signal: abort.signal,
      token: storedAuth.token,
    });

    if (abort.signal.aborted) {
      return;
    }

    if (result.status === 'valid') {
      await saveStoredAuth(storage, result.auth);
      setState({ auth: result.auth, status: 'signedIn' });
      return;
    }

    if (result.status === 'invalid') {
      await clearStoredAuth(storage);
      setState({ message: 'Your session expired. Sign in again.', status: 'signedOut' });
      return;
    }

    setState({ status: 'validationError' });
  }, [stopPolling]);

  useEffect(() => {
    void validateStoredAuth();

    return () => {
      stopPolling();
    };
  }, [stopPolling, validateStoredAuth]);

  useEffect(() => {
    if (state.status !== 'signedIn') {
      return;
    }

    void loadInspectableTabs();
  }, [loadInspectableTabs, state.status]);

  const cancelSignIn = useCallback((): void => {
    stopPolling();
    setState({ status: 'signedOut' });
  }, [stopPolling]);

  const signOut = useCallback((): void => {
    stopPolling();
    void (async (): Promise<void> => {
      await clearStoredAuth(storage);
      setState({ status: 'signedOut' });
    })();
  }, [stopPolling]);

  const startPolling = useCallback(
    (code: string): void => {
      const tick = async (): Promise<void> => {
        const abort = abortRef.current;

        if (abort === null) {
          return;
        }

        try {
          const result = await pollDeviceAuthCode({
            apiBaseUrl,
            code,
            fetch: fetchFromWindow,
            signal: abort.signal,
          });

          if (abort.signal.aborted) {
            return;
          }

          switch (result.status) {
            case 'pending': {
              pollTimeoutRef.current = setTimeout(() => {
                void tick();
              }, pollIntervalMs);
              return;
            }
            case 'approved': {
              stopPolling();
              await saveStoredAuth(storage, result.auth);
              setState({ auth: result.auth, status: 'signedIn' });
              return;
            }
            case 'denied': {
              stopPolling();
              setState({ message: 'Access was denied.', status: 'signedOut' });
              return;
            }
            case 'expired': {
              stopPolling();
              setState({ message: 'Your sign-in code expired.', status: 'signedOut' });
            }
          }
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') {
            return;
          }

          stopPolling();
          setState({ message: 'Sign in failed. Try again.', status: 'signedOut' });
        }
      };

      void tick();
    },
    [stopPolling]
  );

  const startSignIn = useCallback((): void => {
    stopPolling();
    setState({ status: 'starting' });

    void (async (): Promise<void> => {
      try {
        const authRequest = await createDeviceAuthRequest({
          apiBaseUrl,
          fetch: fetchFromWindow,
        });
        const abort = new AbortController();
        abortRef.current = abort;

        setState({
          code: authRequest.code,
          status: 'pending',
          verificationUrl: authRequest.verificationUrl,
        });
        await browser.tabs.create({ url: authRequest.verificationUrl });
        startPolling(authRequest.code);
      } catch {
        setState({ message: 'Failed to start sign in. Try again.', status: 'signedOut' });
      }
    })();
  }, [startPolling, stopPolling]);

  if (state.status === 'checking') {
    return <LoadingView />;
  }

  if (state.status === 'starting') {
    return <SignedOutView isStarting message={state.message} onSignIn={startSignIn} />;
  }

  if (state.status === 'signedOut') {
    return <SignedOutView isStarting={false} message={state.message} onSignIn={startSignIn} />;
  }

  if (state.status === 'pending') {
    return (
      <PendingView
        code={state.code}
        onCancel={cancelSignIn}
        onOpen={() => {
          void browser.tabs.create({ url: state.verificationUrl });
        }}
      />
    );
  }

  if (state.status === 'validationError') {
    return (
      <ValidationErrorView
        onRetry={() => {
          void validateStoredAuth();
        }}
        onSignInAgain={startSignIn}
      />
    );
  }

  if (state.status === 'signedIn') {
    return (
      <SignedInView
        auth={state.auth}
        htmlLength={htmlLength}
        inspectableTabs={inspectableTabs}
        isLoadingTabs={isLoadingTabs}
        isMeasuringHtml={isMeasuringHtml}
        onMeasureHtml={measureSelectedTabHtml}
        onRefreshTabs={() => {
          void loadInspectableTabs();
        }}
        onSelectTab={selectTab}
        onSignOut={signOut}
        selectedTabId={selectedTabId}
        tabDebuggerError={tabDebuggerError}
      />
    );
  }

  return <LoadingView />;
};
