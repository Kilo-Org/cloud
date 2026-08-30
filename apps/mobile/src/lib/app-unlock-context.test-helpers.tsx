/* eslint-disable typescript-eslint/no-deprecated -- Use the repository's DOM-free mounted renderer. */
import { createElement, type ElementType } from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { AppUnlockProvider, useAppUnlock } from '@/lib/app-unlock-context';
import { renderWithProviders } from '@/test/render-with-providers';

export type Unlock = ReturnType<typeof useAppUnlock>;
const native = vi.hoisted(() => ({
  hasHardwareAsync: vi.fn(),
  isEnrolledAsync: vi.fn(),
  getEnrolledLevelAsync: vi.fn(),
  authenticateAsync: vi.fn(),
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
}));
const storage = vi.hoisted(() => ({
  value: null as string | null,
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));
const appState = vi.hoisted(() => ({
  currentState: 'active',
  listener: undefined as ((state: string) => void) | undefined,
  addEventListener: (_event: string, listener: (state: string) => void) => {
    appState.listener = listener;
    return {
      remove: () => {
        appState.listener = undefined;
      },
    };
  },
}));
export { appState, native, storage };
vi.mock('expo-local-authentication', () => native);
vi.mock('expo-secure-store', () => storage);
vi.mock('react-native', () => ({ AppState: appState }));
export const SUCCESS = { success: true };
export const IOS_SUCCESSES = [
  { success: true, error: null, warning: null },
  {
    success: true,
    error: null,
    warning:
      'FaceID is available but has not been configured. To enable FaceID, provide `NSFaceIDUsageDescription`.',
  },
];
let view: Awaited<ReturnType<typeof renderWithProviders>> | undefined = undefined;
let now = 0;
function Probe() {
  return createElement('UnlockState', useAppUnlock());
}
export function state() {
  return view?.renderer.root.findAllByType('UnlockState' as ElementType)[0]?.props as Unlock;
}
async function flush(update?: () => void) {
  await act(async () => {
    update?.();
    await vi.dynamicImportSettled();
  });
}
export async function mount(raw: string | null = 'disabled') {
  storage.value = raw;
  storage.getItemAsync.mockResolvedValue(raw);
  view = await renderWithProviders(
    <AppUnlockProvider promptMessage="Unlock Kilo">
      <Probe />
      <Probe />
    </AppUnlockProvider>
  );
  await flush();
}
export function expectState(enabled: boolean, status: Unlock['status'], busy = false) {
  expect(state()).toMatchObject({ enabled, status, busy });
}
export async function action(enabled?: boolean) {
  await flush(() => {
    if (enabled === undefined) {
      state().retry();
    } else {
      state().setEnabled(enabled);
    }
  });
}
export async function transition(next: string, elapsed = 0) {
  now += elapsed;
  appState.currentState = next;
  await flush(() => {
    appState.listener?.(next);
  });
}
export async function finish<T>(pending: PromiseWithResolvers<T>, result: T | Error) {
  await flush(() => {
    if (result instanceof Error) {
      pending.reject(result);
    } else {
      pending.resolve(result);
    }
  });
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.resetAllMocks();
  now = 10_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  appState.currentState = 'active';
  native.hasHardwareAsync.mockResolvedValue(true);
  native.isEnrolledAsync.mockResolvedValue(true);
  native.getEnrolledLevelAsync.mockResolvedValue(3);
  native.authenticateAsync.mockResolvedValue(SUCCESS);
  storage.setItemAsync.mockImplementation(async (_key: string, value: string) => {
    await Promise.resolve();
    storage.value = value;
  });
});
afterEach(() => {
  view?.unmount();
  view = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
