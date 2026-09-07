/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as use-restore-error-hold.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { usePendingDeepLinkRestore } from '@/lib/hooks/use-pending-deep-link-restore';

const restoreMock = vi.hoisted(() => ({
  restorePersistedPendingDeepLink: vi.fn(),
}));

vi.mock('@/lib/deep-link-launch', () => ({
  restorePersistedPendingDeepLink: restoreMock.restorePersistedPendingDeepLink,
}));

type RestoreProps = {
  authLoading: boolean;
  restoreFailed: boolean;
};

function Harness(props: RestoreProps): null {
  usePendingDeepLinkRestore(props);
  return null;
}

function mount(props: RestoreProps): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(Harness, props));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

async function update(
  renderer: TestRenderer.ReactTestRenderer,
  props: RestoreProps
): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    renderer.update(createElement(Harness, props));
  });
}

describe('usePendingDeepLinkRestore', () => {
  beforeEach(() => {
    // React 19 requires the act environment flag before `act` supports
    // effects (same setup as use-restore-error-hold.mounted.test.tsx).
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    restoreMock.restorePersistedPendingDeepLink.mockClear();
  });

  it('waits for auth bootstrap, then restores exactly once', async () => {
    const renderer = mount({ authLoading: true, restoreFailed: false });
    expect(restoreMock.restorePersistedPendingDeepLink).not.toHaveBeenCalled();

    // Bootstrap settled signed-in: the user id binding is published, the
    // restore may run — once.
    await update(renderer, { authLoading: false, restoreFailed: false });
    expect(restoreMock.restorePersistedPendingDeepLink).toHaveBeenCalledTimes(1);

    // Later renders never re-arm the restore.
    await update(renderer, { authLoading: false, restoreFailed: false });
    expect(restoreMock.restorePersistedPendingDeepLink).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });

  it('holds the restore while the restore error is settled, then runs once it clears', async () => {
    // Cold start with a failed credential read: the account binding is
    // unknown — NOT signed-out — so the persisted record must be left alone.
    const renderer = mount({ authLoading: false, restoreFailed: true });
    expect(restoreMock.restorePersistedPendingDeepLink).not.toHaveBeenCalled();

    // The retry succeeded: bootstrap settled signed-in and the user id is
    // published, so the restore runs against the right account.
    await update(renderer, { authLoading: false, restoreFailed: false });
    expect(restoreMock.restorePersistedPendingDeepLink).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });

  it('holds the restore while the restore error is settled and runs once sign-out settles signed-out', async () => {
    const renderer = mount({ authLoading: false, restoreFailed: true });
    expect(restoreMock.restorePersistedPendingDeepLink).not.toHaveBeenCalled();

    // The sign-out escape hatch cleared the flag: bootstrap settled genuinely
    // signed out, so the restore applies the signed-out semantics (drop
    // account-bound, keep account-independent) exactly once.
    await update(renderer, { authLoading: false, restoreFailed: false });
    expect(restoreMock.restorePersistedPendingDeepLink).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });

  it('holds the restore while a retry load runs behind the error surface', async () => {
    // The error surface settled, then Retry raised the loading gate: the
    // restore stays held for the whole retried bootstrap.
    const renderer = mount({ authLoading: false, restoreFailed: true });
    expect(restoreMock.restorePersistedPendingDeepLink).not.toHaveBeenCalled();

    await update(renderer, { authLoading: true, restoreFailed: true });
    expect(restoreMock.restorePersistedPendingDeepLink).not.toHaveBeenCalled();

    await update(renderer, { authLoading: false, restoreFailed: false });
    expect(restoreMock.restorePersistedPendingDeepLink).toHaveBeenCalledTimes(1);
    renderer.unmount();
  });
});
