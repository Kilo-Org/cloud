import {
  buttonByLabel,
  type CapturedConfirm,
  confirmRemoval,
  confirmSpy,
  first,
  hasButtonLabel,
  list,
  MACBOOK,
  mount,
  nodes,
  press,
  retry,
  rowAction,
  store,
  texts,
  toastError,
  toastSuccess,
  UNNAMED,
  USED,
  VERIFY_TITLE,
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
  // The proof the panel offers: a code to the account's own address, which is
  // the only proof an account adding its first passkey can give.
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

describe('PasskeysScreen', () => {
  it('shows skeleton rows sized like the final rows while loading', async () => {
    list.queryFn.mockImplementation(async () => {
      await new Promise(() => undefined);
    });
    const view = await mount();

    expect(nodes(view, 'Skeleton')).toHaveLength(9);
    // The Add CTA is on screen from the first frame, in its final slot.
    expect(hasButtonLabel(view, 'Add a passkey')).toBe(true);
    expect(nodes(view, 'EmptyState')).toHaveLength(0);
    view.unmount();
  });

  it('offers creation as the only action when there are no passkeys', async () => {
    store.rows = [];
    const view = await mount();
    await waitFor(() => nodes(view, 'EmptyState').length === 1);

    const empty = first(view, 'EmptyState');
    expect(empty.props.title).toBe('No passkeys yet');
    expect(empty.props.description).toBe('Add a passkey to sign in without a password.');
    expect(hasButtonLabel(view, 'Add a passkey')).toBe(true);
    view.unmount();
  });

  it('keeps the Add control in the header slot, outside the scrolling body', async () => {
    const view = await mount();
    await waitFor(() => texts(view).includes('MacBook'));

    // The create control's slot is the header. Nothing the list renders —
    // skeletons, rows, or the empty state — carries it, so its coordinates
    // cannot move when the query settles and swaps one of those for another.
    const header = first(view, 'ScreenHeader');
    expect(
      header.findAll(
        node => String(node.type) === 'Pressable' && node.props.accessibilityLabel === 'Add a passkey'
      )
    ).toHaveLength(1);
    const addInsideScroll = first(view, 'ScrollView').findAll(
      node => node.props.accessibilityLabel === 'Add a passkey'
    );
    expect(addInsideScroll).toHaveLength(0);
    view.unmount();
  });

  it('lists a row per passkey with its name and created date', async () => {
    const view = await mount();
    await waitFor(() => texts(view).includes('MacBook'));

    expect(texts(view)).toContain('MacBook');
    // A credential the server stored without a name still reads as a passkey.
    expect(texts(view)).toContain('Passkey');
    expect(texts(view)).toContain('Added Jan 1, 2026');
    expect(nodes(view, 'KeyRound')).toHaveLength(2);
    view.unmount();
  });

  it('shows the last-used date only on a passkey the server recorded a use for', async () => {
    // One credential carries a last_used_at and one does not, so the test reads
    // both sides of the condition from the same render.
    store.rows = [USED, MACBOOK];
    const view = await mount();
    await waitFor(() => texts(view).includes('Work laptop'));

    expect(texts(view)).toContain('Work laptop');
    expect(texts(view)).toContain('MacBook');
    expect(texts(view)).toContain('Added Jan 1, 2026');
    // Each fact keeps its own line: a recorded use prints under the added date,
    // and a credential the server has never seen used keeps the date alone.
    expect(texts(view)).toContain('Last used Jan 1, 2026');
    expect(texts(view).filter(text => text === 'Last used Jan 1, 2026')).toHaveLength(1);
    view.unmount();
  });

  it('asks before removing, drops the row, and empties the list when it was the last one', async () => {
    store.rows = [MACBOOK];
    const pendingDelete = Promise.withResolvers<unknown>();
    const releaseDelete = () => {
      pendingDelete.resolve(undefined);
    };
    list.deleteFn.mockImplementation(async () => {
      await pendingDelete.promise;
      store.rows = [];
    });
    const view = await mount();
    await waitFor(() => texts(view).includes('MacBook'));

    await press(rowAction(view, 'Remove'));
    // The confirmation is the in-app dialog, not a native alert: the request
    // carries the labels the dialog renders and the onConfirm that removes.
    expect(confirmSpy).toHaveBeenCalledOnce();
    const request = confirmSpy.mock.calls[0]?.[0] as CapturedConfirm;
    expect(request.title).toBe('Remove passkey?');
    expect(request.message).toBe('You will no longer be able to sign in with this passkey.');
    expect(request.confirmLabel).toBe('Remove passkey');

    // Removed optimistically, before the server answered: with no row left, the
    // empty state is the surface. The delete itself waits for fresh proof.
    await confirmRemoval();
    await verifyWithCode(view);
    await waitFor(() => nodes(view, 'EmptyState').length === 1);
    expect(texts(view)).not.toContain('MacBook');
    // The mutation receives its context as a second argument; the variables
    // are what the delete must carry: the one credential and its grant.
    expect(list.deleteFn.mock.calls[0]?.[0]).toEqual({
      id: 'pk-1',
      managementAuthorization: 'auth-1',
    });

    await act(() => {
      releaseDelete();
    });
    await waitFor(() => toastSuccess.mock.calls.length > 0);
    expect(toastSuccess).toHaveBeenCalledWith('Passkey removed.');
    expect(nodes(view, 'EmptyState')).toHaveLength(1);
    view.unmount();
  });

  it('rolls a failed removal back and reports it with a working retry', async () => {
    list.deleteFn.mockRejectedValue(new Error('nope'));
    const view = await mount();
    await waitFor(() => texts(view).includes('MacBook'));

    await press(rowAction(view, 'Remove'));
    await confirmRemoval();
    await verifyWithCode(view);

    // The row is back, the failure is inline beside it, and the toast carries
    // the server's own message.
    await waitFor(() => texts(view).includes('Could not remove that passkey. Try again.'));
    expect(texts(view)).toContain('MacBook');
    expect(toastError).toHaveBeenCalledWith('nope');

    // The retry asks for proof again before it re-sends the delete.
    await press(buttonByLabel(view, 'Retry'));
    await verifyWithCode(view);
    await waitFor(() => list.deleteFn.mock.calls.length === 2);
    view.unmount();
  });

  it('shows a retryable load failure when no passkey list ever arrived', async () => {
    list.queryFn.mockRejectedValue(new Error('down'));
    const view = await mount();
    await waitFor(() => nodes(view, 'QueryError').length === 1);

    const error = first(view, 'QueryError');
    expect(error.props.title).toBe('Could not load passkeys');
    expect(error.props.message).toBe('Passkeys are unavailable until this loads.');
    const calls = list.queryFn.mock.calls.length;
    await retry(error);
    expect(list.queryFn.mock.calls.length).toBeGreaterThan(calls);
    view.unmount();
  });

  it('keeps the rows it already rendered when a refresh fails', async () => {
    const view = await mount();
    await waitFor(() => texts(view).includes('MacBook'));

    list.queryFn.mockRejectedValue(new Error('down'));
    await act(async () => {
      await view.queryClient.refetchQueries({ queryKey: list.key });
    });
    await waitFor(() => texts(view).includes('Could not load passkeys'));

    // The rows the screen already rendered are still there, beside the notice.
    expect(texts(view)).toContain('MacBook');
    expect(nodes(view, 'QueryError')).toHaveLength(0);
    view.unmount();
  });

  it('renames through the modal with the current name prefilled and fresh proof', async () => {
    const view = await mount();
    await waitFor(() => texts(view).includes('MacBook'));

    await press(rowAction(view, 'Rename'));
    const modal = first(view, 'RenameModal');
    expect(modal.props.title).toBe('Rename passkey');
    expect(modal.props.placeholder).toBe('Passkey name');
    expect(modal.props.initialValue).toBe('MacBook');

    await act(async () => {
      await (modal.props.onSave as (name: string) => Promise<void>)('Work laptop');
    });
    // The modal closes with the name captured; the rename waits for proof.
    await waitFor(() => texts(view).includes(VERIFY_TITLE));
    expect(list.renameFn).not.toHaveBeenCalled();

    await verifyWithCode(view);
    await waitFor(() => toastSuccess.mock.calls.length > 0);
    expect(list.renameFn.mock.calls[0]?.[0]).toEqual({
      id: 'pk-1',
      name: 'Work laptop',
      managementAuthorization: 'auth-1',
    });
    expect(toastSuccess).toHaveBeenCalledWith('Passkey renamed.');
    view.unmount();
  });

  it('reports a failed rename with the server message', async () => {
    list.renameFn.mockRejectedValue(new Error('nope'));
    const view = await mount();
    await waitFor(() => texts(view).includes('MacBook'));

    await press(rowAction(view, 'Rename'));
    const modal = first(view, 'RenameModal');
    await act(async () => {
      await (modal.props.onSave as (name: string) => Promise<void>)('Work laptop');
    });
    await verifyWithCode(view);
    await waitFor(() => toastError.mock.calls.length > 0);

    expect(toastError).toHaveBeenCalledWith('nope');
    view.unmount();
  });

  it('locks the removal retry while the retried delete is in flight', async () => {
    // Two passkeys, so the retried delete's optimistic removal leaves a row
    // beside the failure notice instead of emptying the list under it.
    list.deleteFn.mockRejectedValueOnce(new Error('nope'));
    const view = await mount();
    await waitFor(() => texts(view).includes('MacBook'));

    await press(rowAction(view, 'Remove'));
    await confirmRemoval();
    await verifyWithCode(view);
    await waitFor(() => texts(view).includes('Could not remove that passkey. Try again.'));

    // The retried delete is now in flight. While it is, the control must not be
    // startable again: a second tap would send a concurrent delete of the same
    // id whose rollback could hide a passkey the server still has.
    const pendingRetry = Promise.withResolvers<unknown>();
    const releaseRetry = () => {
      pendingRetry.resolve(undefined);
    };
    list.deleteFn.mockImplementation(() => pendingRetry.promise);
    await press(buttonByLabel(view, 'Retry'));
    await verifyWithCode(view);
    await waitFor(() => buttonByLabel(view, 'Retry').props.loading === true);

    const retryButton = buttonByLabel(view, 'Retry');
    // The real Button sets `disabled` from `loading` (button.tsx), so the
    // control cannot be tapped again until this delete settles.
    expect(retryButton.props.loading).toBe(true);
    expect(list.deleteFn).toHaveBeenCalledTimes(2);

    await act(() => {
      releaseRetry();
    });
    await waitFor(() => toastSuccess.mock.calls.length > 0);
    expect(toastSuccess).toHaveBeenCalledWith('Passkey removed.');
    view.unmount();
  });

  it('drops a removal failure once the passkey is gone from the reconciled list', async () => {
    list.deleteFn.mockRejectedValue(new Error('nope'));
    const view = await mount();
    await waitFor(() => texts(view).includes('MacBook'));

    await press(rowAction(view, 'Remove'));
    await confirmRemoval();
    await verifyWithCode(view);
    await waitFor(() => texts(view).includes('Could not remove that passkey. Try again.'));

    // The passkey is gone from the server list — another device removed it, or
    // the refused call had in fact landed. The same delete can only fail again,
    // so the notice must not outlive the row it was about.
    store.rows = [UNNAMED];
    await act(async () => {
      await view.queryClient.refetchQueries({ queryKey: list.key });
    });

    await waitFor(() => !texts(view).includes('Could not remove that passkey. Try again.'));
    expect(texts(view)).not.toContain('MacBook');
    expect(texts(view)).toContain('Passkey');
    expect(hasButtonLabel(view, 'Retry')).toBe(false);
    view.unmount();
  });
});
