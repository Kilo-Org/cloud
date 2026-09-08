import * as SecureStore from 'expo-secure-store';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { z } from 'zod';

import { readStoredValueWithRetry } from '@/lib/auth/secure-store-read';

// Device-local, not account metadata. The only stored values are enabled/disabled.
const STORAGE_KEY = 'app-unlock-enabled';
const BACKGROUND_LOCK_MS = 300_000;
const nativeResultSchema = z.discriminatedUnion('success', [
  // iOS includes nullable error and warning fields even after success.
  z.strictObject({
    success: z.literal(true),
    error: z.null().optional(),
    warning: z.string().nullish(),
  }),
  z.object({ success: z.literal(false), error: z.string() }),
]);

type Outcome =
  | { status: 'success' | 'cancelled' | 'failed' | 'lockout' | 'save-failed' }
  | {
      status: 'setup-required';
      reason: 'missing-hardware' | 'not-enrolled' | 'not-available' | 'passcode-not-set';
    };

type UnlockState = {
  enabled: boolean;
  status: 'preference-loading' | 'locked' | 'unlocked';
  purpose: 'unlock' | 'setting' | null;
  phase: 'idle' | 'reading' | 'authenticating' | 'saving';
  outcome: Outcome | null;
};
type AppUnlockContextValue = UnlockState & {
  busy: boolean;
  retry: () => void;
  setEnabled: (enabled: boolean) => void;
};
const AppUnlockContext = createContext<AppUnlockContextValue | undefined>(undefined);

async function authenticateDevice(promptMessage: string): Promise<Outcome> {
  try {
    // Import inside the error boundary: an old native client can lack the module.
    const native = await import('expo-local-authentication');
    const [hardware, enrolled, level] = await Promise.all([
      native.hasHardwareAsync(),
      native.isEnrolledAsync(),
      native.getEnrolledLevelAsync(),
    ]);
    switch (level) {
      case native.SecurityLevel.NONE: {
        if (!hardware) {
          return { status: 'setup-required', reason: 'missing-hardware' };
        }
        return { status: 'setup-required', reason: enrolled ? 'not-available' : 'not-enrolled' };
      }
      case native.SecurityLevel.SECRET:
      case native.SecurityLevel.BIOMETRIC_WEAK:
      case native.SecurityLevel.BIOMETRIC_STRONG: {
        break;
      }
      default: {
        return { status: 'failed' };
      }
    }
    const result = nativeResultSchema.parse(
      await native.authenticateAsync({ promptMessage, disableDeviceFallback: false })
    );
    if (result.success) {
      return { status: 'success' };
    }
    switch (result.error) {
      case 'user_cancel':
      case 'app_cancel':
      case 'system_cancel':
      case 'user_fallback': {
        return { status: 'cancelled' };
      }
      case 'not_enrolled': {
        return { status: 'setup-required', reason: 'not-enrolled' };
      }
      case 'not_available': {
        return { status: 'setup-required', reason: 'not-available' };
      }
      case 'passcode_not_set': {
        return { status: 'setup-required', reason: 'passcode-not-set' };
      }
      case 'lockout': {
        return { status: 'lockout' };
      }
      default: {
        return { status: 'failed' };
      }
    }
  } catch {
    return { status: 'failed' };
  }
}

export function AppUnlockProvider({
  children,
  promptMessage,
}: {
  readonly children: ReactNode;
  // Null while the existing language bootstrap resolves the prompt's catalog.
  readonly promptMessage: string | null;
}) {
  const [state, setState] = useState<UnlockState>({
    enabled: false,
    status: 'preference-loading',
    purpose: null,
    phase: 'idle',
    outcome: null,
  });
  const current = useRef(state);
  const mounted = useRef(false);
  const prompt = useRef(promptMessage);
  const appState = useRef(AppState.currentState);
  const background = useRef<{ generation: number; startedAt: number } | null>(null);
  const intervalGeneration = useRef(0);
  const coveredInterval = useRef(0);
  const attemptedInterval = useRef(0);
  const coldStartPending = useRef(false);
  // True only while the live state is the fail-open of an exhausted read
  // budget, so foreground recovery knows to re-read the preference.
  const readFailed = useRef(false);

  const publish = useCallback((patch: Partial<UnlockState>) => {
    if (mounted.current) {
      // Native events must see the committed value and busy phase before React renders.
      current.current = { ...current.current, ...patch };
      setState(current.current);
    }
  }, []);

  const authenticate = useCallback(
    async (nextEnabled?: boolean) => {
      const saved = current.current;
      const isMounted = mounted.current;
      const message = prompt.current;
      if (
        message === null ||
        !isMounted ||
        saved.phase !== 'idle' ||
        appState.current !== 'active' ||
        (saved.status !== 'locked' && saved.status !== 'unlocked') ||
        (nextEnabled === undefined ? saved.status !== 'locked' : nextEnabled === saved.enabled)
      ) {
        return;
      }
      coldStartPending.current = false;
      publish({
        purpose: nextEnabled === undefined ? 'unlock' : 'setting',
        phase: 'authenticating',
        outcome: null,
      });
      const outcome = await authenticateDevice(message);
      if (!mounted.current) {
        return;
      }
      // A failed attempt leaves its pending return gated, without another prompt.
      attemptedInterval.current = background.current?.generation ?? 0;
      if (outcome.status !== 'success') {
        publish({ phase: 'idle', outcome });
        return;
      }
      // Success covers the current gate and only this interval's pending return.
      // AppState describes status, not whether a prompt caused that status.
      coveredInterval.current = background.current?.generation ?? 0;
      publish({ status: 'unlocked' });
      if (nextEnabled !== undefined) {
        publish({ phase: 'saving' });
        try {
          await SecureStore.setItemAsync(STORAGE_KEY, nextEnabled ? 'enabled' : 'disabled');
          publish({
            enabled: nextEnabled,
            // Saving is not authentication: preserve a newer gate unless now disabled.
            status: nextEnabled ? current.current.status : 'unlocked',
          });
        } catch {
          publish({ phase: 'idle', outcome: { status: 'save-failed' } });
          return;
        }
      }
      publish({ phase: 'idle', outcome });
    },
    [publish]
  );

  const restore = useCallback(async () => {
    if (current.current.phase !== 'idle') {
      return;
    }
    publish({ status: 'preference-loading', phase: 'reading', purpose: null, outcome: null });
    // An unreadable or invalid preference fails open to the documented no-key
    // default instead of gating the app behind a Retry tap. This does not
    // weaken authentication: the key holds only enabled/disabled and is
    // device-local, not account metadata (see STORAGE_KEY); old installations
    // without the key are documented disabled; and the session, token owner,
    // refresh, and 401 sign-out paths never consult it — only this
    // convenience device lock defaults to its documented off state when
    // unreadable. A person who enabled it can re-enable from Preferences,
    // which rewrites the key (`setEnabled`); and an exhausted budget is not
    // final — the fail-open stands only until the next foreground, where
    // `reReadAfterFailure` re-reads the key once the keychain recovers.
    const failOpen = () => {
      publish({ enabled: false, status: 'unlocked', phase: 'idle', outcome: null });
    };
    try {
      // Bounded retries cover the transient post-reboot keychain window; only
      // the final rejection reaches the fail-open below.
      const raw = await readStoredValueWithRetry(STORAGE_KEY);
      if (!mounted.current) {
        return;
      }
      if (raw !== null && raw !== 'enabled' && raw !== 'disabled') {
        // An invalid value is deterministic: a retry would re-read the same
        // bytes, so fail open without spending the read budget.
        failOpen();
        return;
      }
      // Old installations have no key and remain disabled. Keep this fallback
      // until those installations and records cannot exist; this section retains it.
      const enabled = raw === 'enabled';
      coldStartPending.current = enabled;
      publish({ enabled, status: enabled ? 'locked' : 'unlocked', phase: 'idle' });
      if (enabled && appState.current === 'active') {
        void authenticate();
      }
    } catch {
      // The retry budget is exhausted, not the preference: re-read on
      // foreground recovery instead of failing open for the whole session.
      // An invalid value never lands here (handled above) because a re-read
      // would return the same bytes.
      readFailed.current = true;
      failOpen();
    }
  }, [authenticate, publish]);

  // Foreground recovery for an exhausted read budget: re-read silently — no
  // 'preference-loading' publish, so live content never hides behind the
  // unlock surface while the keychain is still down — and re-arm the lock
  // when the key answers enabled. The in-progress return is not retro-gated;
  // the re-armed preference gates every later background return and cold
  // start exactly like a healthy read would.
  const reReadAfterFailure = useCallback(async () => {
    try {
      const raw = await readStoredValueWithRetry(STORAGE_KEY);
      // Any answer (disabled, absent, or invalid) settles the fail-open; only
      // a rejection keeps the re-read armed for the next foreground. A busy
      // phase (a save in flight) skips the publish, which drops it when
      // unmounted anyway.
      readFailed.current = false;
      if (raw === 'enabled' && !current.current.enabled && current.current.phase === 'idle') {
        publish({ enabled: true });
      }
    } catch {
      // Still unreadable: the fail-open stands until the next foreground.
    }
  }, [publish]);

  useEffect(() => {
    prompt.current = promptMessage;
    if (coldStartPending.current) {
      void authenticate();
    }
  }, [authenticate, promptMessage]);

  useEffect(() => {
    mounted.current = true;
    const onChange = (next: AppStateStatus) => {
      appState.current = next;
      if (next === 'background' && !background.current) {
        intervalGeneration.current += 1;
        background.current = { generation: intervalGeneration.current, startedAt: Date.now() };
      }
      if (next !== 'active') {
        return;
      }
      const interval = background.current;
      background.current = null;
      if (!current.current.enabled) {
        if (readFailed.current) {
          // An exhausted budget lost the lock: recover it here.
          void reReadAfterFailure();
        }
        return;
      }
      const requiresLock =
        interval !== null &&
        interval.generation !== coveredInterval.current &&
        Date.now() - interval.startedAt >= BACKGROUND_LOCK_MS;
      if (requiresLock) {
        publish({ status: 'locked' });
      }
      const alreadyAttempted = interval?.generation === attemptedInterval.current;
      if (coldStartPending.current || (requiresLock && !alreadyAttempted)) {
        // A busy operation retains the trigger, but never queues a recursive prompt.
        void authenticate();
      }
    };
    const subscription = AppState.addEventListener('change', onChange);
    onChange(AppState.currentState);
    void restore();
    return () => {
      mounted.current = false;
      subscription.remove();
    };
  }, [authenticate, publish, reReadAfterFailure, restore]);

  const retry = useCallback(() => {
    if (current.current.status === 'locked') {
      void authenticate();
    }
  }, [authenticate]);
  const setEnabled = useCallback(
    (enabled: boolean) => {
      void authenticate(enabled);
    },
    [authenticate]
  );
  const value = useMemo<AppUnlockContextValue>(
    () => ({
      ...state,
      busy:
        promptMessage === null || state.status === 'preference-loading' || state.phase !== 'idle',
      retry,
      setEnabled,
    }),
    [promptMessage, state, retry, setEnabled]
  );
  return <AppUnlockContext value={value}>{children}</AppUnlockContext>;
}

export function useAppUnlock(): AppUnlockContextValue {
  const context = useContext(AppUnlockContext);
  if (!context) {
    throw new Error('useAppUnlock must be used within an AppUnlockProvider');
  }
  return context;
}
