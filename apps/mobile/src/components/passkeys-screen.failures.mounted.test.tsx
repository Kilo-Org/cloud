import {
  buttonByLabel,
  confirmRemoval,
  confirmSpy,
  emptyDescription,
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
  verifyWithCode,
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
  list.requestCode.mockResolvedValue({
    status: 'sent',
    challengeId: '3f1c1a9e-1c1a-4b6e-9f0e-1d2c3b4a5e6f',
  });
  list.authorizeCode.mockResolvedValue({
    status: 'authorized',
    authorization: 'auth-1',
    expiresAtMs: Date.now() + 300_000,
  });
  list.authorizeTicket.mockResolvedValue({
    status: 'authorized',
    authorization: 'auth-1',
    expiresAtMs: Date.now() + 300_000,
  });
  list.mintTicket.mockResolvedValue({ status: 'ok', ticket: 'ticket-1' });
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
    list.deleteFn.mockRejectedValueOnce(new Error('nope'));
    const view = await mount();
    await waitFor(() => texts(view).includes('MacBook'));

    await press(rowAction(view, 'Remove'));
    await confirmRemoval();
    await verifyWithCode(view);
    await waitFor(() => texts(view).includes('Could not remove that passkey. Try again.'));

    // A second passkey's removal is running. The retry in the notice names the
    // first one's delete, and that delete is not in flight, so the control must
    // stay startable while the other removal is.
    const pendingOther = Promise.withResolvers<undefined>();
    list.deleteFn.mockImplementation(() => pendingOther.promise);
    confirmSpy.mockClear();
    const removeControls = nodes(view, 'Pressable').filter(
      node => node.props.accessibilityLabel === 'Remove'
    );
    const otherRemove = removeControls[1];
    if (!otherRemove) {
      throw new Error('second row Remove not found');
    }
    await press(otherRemove);
    await confirmRemoval();
    await verifyWithCode(view);

    await waitFor(() => list.deleteFn.mock.calls.length === 2);
    expect(buttonByLabel(view, 'Retry').props.loading).toBe(false);

    await act(() => {
      pendingOther.resolve(undefined);
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
    await verifyWithCode(view);
    await waitFor(() => texts(view).includes('Could not add a passkey. Try again.'));

    // A rejection must not leave the control loading forever: it is free again
    // and starts a fresh attempt, exactly like any other retryable failure.
    expect(buttonByLabel(view, 'Add a passkey').props.loading).toBe(false);
    view.unmount();
  });

  it('resets the Add control once the attempt settles: enabled, not loading, still offered', async () => {
    store.rows = [];
    list.register.mockResolvedValue({ status: 'error', failure: 'failed' });
    const view = await mount();
    await waitFor(() => nodes(view, 'EmptyState').length === 1);

    await press(buttonByLabel(view, 'Add a passkey'));
    await verifyWithCode(view);
    await waitFor(() => texts(view).includes('Could not add a passkey. Try again.'));
    // The label re-derivation itself is covered in button.mounted.test.tsx;
    // here the failed ceremony settles back to an enabled, offered control.
    expect(buttonByLabel(view, 'Add a passkey').props.loading).toBe(false);
    view.unmount();
  });

  it('withdraws the Add control when this sign-in can never manage passkeys', async () => {
    store.rows = [MACBOOK];
    list.register.mockResolvedValue({ status: 'error', failure: 'device-unsupported' });
    const view = await mount();
    await waitFor(() => texts(view).includes('MacBook'));

    await press(buttonByLabel(view, 'Add a passkey'));
    await verifyWithCode(view);
    await waitFor(() =>
      texts(view).includes(
        "Passkeys can't be managed with this sign-in. Sign in again in the Kilo app."
      )
    );

    // Repeating the same request cannot succeed, so the control is gone and the
    // notice is the state: the rows the account already has stay listed, and no
    // browser-only instruction is shown anywhere.
    expect(hasButtonLabel(view, 'Add a passkey')).toBe(false);
    expect(texts(view)).toContain('MacBook');
    expect(texts(view).join(' ')).not.toContain('web browser');
    view.unmount();
  });

  it('replaces the empty state hint with the same notice', async () => {
    store.rows = [];
    list.register.mockResolvedValue({ status: 'error', failure: 'device-unsupported' });
    const view = await mount();
    await waitFor(() => nodes(view, 'EmptyState').length === 1);

    await press(buttonByLabel(view, 'Add a passkey'));
    await verifyWithCode(view);
    await waitFor(() => !hasButtonLabel(view, 'Add a passkey'));

    // Non-retryable: no retry control, and no Add control that could only be
    // refused the same way again. The notice takes the hint's place.
    expect(hasButtonLabel(view, 'Retry')).toBe(false);
    expect(emptyDescription(view)).toBe(
      "Passkeys can't be managed with this sign-in. Sign in again in the Kilo app."
    );
    view.unmount();
  });

  it('names the reason the control went away when a press lands during the first load', async () => {
    // The footer keeps its coordinates whatever the body renders, so the Add
    // control is pressable while the first load is still skeletons. Its refusal
    // then has no empty state to sit in, and the footer must still say why the
    // control is gone.
    list.queryFn.mockImplementation(() => new Promise<void>(() => undefined));
    list.register.mockResolvedValue({ status: 'error', failure: 'device-unsupported' });
    const view = await mount();
    await waitFor(() => nodes(view, 'Skeleton').length > 0);

    await press(buttonByLabel(view, 'Add a passkey'));
    await verifyWithCode(view);
    await waitFor(() => !hasButtonLabel(view, 'Add a passkey'));

    expect(texts(view)).toContain(
      "Passkeys can't be managed with this sign-in. Sign in again in the Kilo app."
    );
    view.unmount();
  });
});
