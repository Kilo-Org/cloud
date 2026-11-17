// The picker's Manage access control is the only way to widen what the
// repository list may show, so a tap that produces nothing is the whole defect:
// it has to draw a busy state while the hand-off token is minted, never start a
// second launch from a repeated tap, and report a launch that failed — including
// one that failed after the app's own return edge ended the wait.

/** Shared mocks and mounting for the Manage-access suites. */
import * as React from 'react';
import { vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import {
  type ManageRepositoryAccess,
  useManageRepositoryAccess,
} from './use-manage-repository-access';

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  handoffUrl: vi.fn((_target: unknown): Promise<string> =>
    Promise.resolve('https://app.example.com/app-shell/handoff?token=handoff-token')
  ),
  launch: vi.fn<(url: string) => Promise<unknown>>(),
}));

/** The URL the hand-off mock mints for every target. */
export const HANDOFF_URL = 'https://app.example.com/app-shell/handoff?token=handoff-token';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('sonner-native', () => ({ toast: { error: mocks.toastError } }));

vi.mock('@/lib/hooks/use-code-reviewer', () => ({
  isPersonal: (scope: string) => scope === 'personal',
}));

vi.mock('@/lib/app-shell-handoff', () => ({ appShellHandoffUrl: mocks.handoffUrl }));

vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: {
    addEventListener: () => ({ remove: () => undefined }),
    currentState: 'active',
  },
}));

vi.mock('expo-web-browser', () => ({
  openAuthSessionAsync: vi.fn(),
  openBrowserAsync: vi.fn(),
  WebBrowserResultType: { OPENED: 'opened', CANCEL: 'cancel', DISMISS: 'dismiss' },
}));

// Only the launch is faked: the late-failure report under test is the real one.
vi.mock('@/lib/pr-review/connect-gate-platform', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  openAuthorizationAndWaitForReturn: mocks.launch,
}));

/** The module mocks. A hoisted variable cannot be exported, so a suite reads it here. */
export function accessMocks() {
  return mocks;
}

export type HookResult = ManageRepositoryAccess | undefined;

export type Handlers = { onOpen?: () => void; onReturn?: (opened: boolean) => void };

function Harness({
  scope,
  platform,
  handlers,
  resultRef,
}: {
  scope: string;
  platform: 'github' | 'gitlab' | 'bitbucket';
  handlers: Handlers;
  resultRef: { current: HookResult };
}) {
  resultRef.current = useManageRepositoryAccess(scope, platform, handlers);
  return null;
}

export function mountHook(
  scope: string,
  platform: 'github' | 'gitlab' | 'bitbucket',
  handlers: Handlers = {}
): { current: HookResult } {
  const resultRef: { current: HookResult } = { current: undefined };
  act(() => {
    TestRenderer.create(React.createElement(Harness, { scope, platform, handlers, resultRef }));
  });
  return resultRef;
}

export function requireHook(resultRef: { current: HookResult }): ManageRepositoryAccess {
  const result = resultRef.current;
  if (!result) {
    throw new Error('useManageRepositoryAccess returned no action');
  }
  return result;
}

/** Reset the mocks to a successful mint and a reporting launch. */
export function resetAccessMocks(): void {
  vi.clearAllMocks();
  mocks.handoffUrl.mockImplementation(() =>
    Promise.resolve('https://app.example.com/app-shell/handoff?token=handoff-token')
  );
  mocks.launch.mockImplementation(() =>
    Promise.resolve({ reported: Promise.resolve({ type: 'dismiss' }), settledByLaunch: true })
  );
}
