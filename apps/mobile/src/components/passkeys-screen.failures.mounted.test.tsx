import {
  alertSpy,
  buttonByLabel,
  confirmRemoval,
  hasButtonLabel,
  list,
  MACBOOK,
  mount,
  nodes,
  press,
  rowAction,
  store,
  texts,
  toastSuccess,
  UNNAMED,
} from './passkeys-screen.test-helpers';
import { act } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@/test/render-with-providers';

beforeEach(() => {
  vi.clearAllMocks();
  store.rows = [MACBOOK, UNNAMED];
  list.supported.mockReturnValue(true);
  list.queryFn.mockImplementation(() => ({ success: true, passkeys: store.rows }));
  list.deleteFn.mockResolvedValue(undefined);
  list.renameFn.mockResolvedValue(undefined);
  list.register.mockResolvedValue({ status: 'ok' });
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('PasskeysScreen inline failures', () => {
  it('reports a failed refresh that left the cached list empty, with a working retry', async () => {
    store.rows = [];
    const view = await mount();
    await waitFor(() => nodes(view, 'EmptyState').length === 1);

    list.queryFn.mockRejectedValue(new Error('down'));
    await act(async () => {
      await view.queryClient.refetchQueries({ queryKey: list.key });
    });
    await waitFor(() => texts(view).includes('Could not load passkeys'));

    // The empty state alone would hide the failure: it stays, and the notice
    // beside it is what says the request failed and offers the retry.
    expect(nodes(view, 'EmptyState')).toHaveLength(1);
    expect(hasButtonLabel(view, 'Retry')).toBe(true);

    const calls = list.queryFn.mock.calls.length;
    await press(buttonByLabel(view, 'Retry'));
    await waitFor(() => list.queryFn.mock.calls.length > calls);
    view.unmount();
  });

  it('does not lock the removal retry while a different removal runs', async () => {
    let releaseOtherDelete: (() => void) | undefined = undefined;
    list.deleteFn.mockRejectedValueOnce(new Error('nope'));
    const view = await mount();
    await waitFor(() => texts(view).includes('MacBook'));

    await press(rowAction(view, 'Remove'));
    await confirmRemoval(alertSpy);
    await waitFor(() => texts(view).includes('Could not remove that passkey. Try again.'));

    // A second passkey's removal is running. The retry in the notice names the
    // first one's delete, and that delete is not in flight, so the control must
    // stay startable while the other removal is.
    list.deleteFn.mockImplementation(async () => {
      await new Promise<void>(resolve => {
        releaseOtherDelete = resolve;
      });
    });
    alertSpy.mockClear();
    const removeControls = nodes(view, 'Pressable').filter(
      node => node.props.accessibilityLabel === 'Remove'
    );
    const otherRemove = removeControls[1];
    if (!otherRemove) {
      throw new Error('second row Remove not found');
    }
    await press(otherRemove);
    await confirmRemoval(alertSpy);

    await waitFor(() => list.deleteFn.mock.calls.length === 2);
    expect(buttonByLabel(view, 'Retry').props.loading).toBe(false);

    await act(() => {
      releaseOtherDelete?.();
    });
    await waitFor(() => toastSuccess.mock.calls.length > 0);
    view.unmount();
  });

  it('frees the Add control and names a rejected ceremony as retryable', async () => {
    store.rows = [];
    // `registerPasskey` can reject before its own handling: the request-token
    // read behind the ceremony rejects when the keychain read fails.
    list.register.mockRejectedValue(new Error('keychain read failed'));
    const view = await mount();
    await waitFor(() => nodes(view, 'EmptyState').length === 1);

    await press(buttonByLabel(view, 'Add a passkey'));
    await waitFor(() => texts(view).includes('Could not add a passkey. Try again.'));

    // A rejection must not leave the control loading forever: it is free again
    // and starts a fresh ceremony, exactly like any other retryable failure.
    expect(buttonByLabel(view, 'Add a passkey').props.loading).toBe(false);
    view.unmount();
  });
});
