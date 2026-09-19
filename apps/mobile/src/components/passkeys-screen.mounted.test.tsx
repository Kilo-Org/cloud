import {
  alertSpy,
  buttonByLabel,
  confirmRemoval,
  emptyDescription,
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

describe('PasskeysScreen', () => {
  it('shows skeleton rows sized like the final rows while loading', async () => {
    list.queryFn.mockImplementation(async () => {
      await new Promise(() => undefined);
    });
    const view = await mount();

    expect(nodes(view, 'Skeleton')).toHaveLength(15);
    // Every row reserves both controls' final 44x44pt boxes, so a loaded row is
    // the same height as its skeleton and the list does not jump on load.
    expect(
      nodes(view, 'View').filter(node => String(node.props.className).includes('min-h-[44px]'))
    ).toHaveLength(6);
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

  it('keeps the Add control in the footer slot, outside the scrolling body', async () => {
    const view = await mount();
    await waitFor(() => texts(view).includes('MacBook'));

    // The control's slot is the footer. Nothing the list renders — skeletons,
    // rows, or the empty state — carries it, so its coordinates cannot move
    // when the query settles and swaps one of those for another.
    const addInsideScroll = first(view, 'ScrollView').findAll(
      inner =>
        String(inner.type) === 'Button' &&
        inner.findAll(
          leaf => String(leaf.type) === 'Text' && leaf.props.children === 'Add a passkey'
        ).length > 0
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

  it('asks before removing, drops the row, and empties the list when it was the last one', async () => {
    let releaseDelete: (() => void) | undefined = undefined;
    store.rows = [MACBOOK];
    list.deleteFn.mockImplementation(async () => {
      await new Promise<void>(resolve => {
        releaseDelete = () => {
          store.rows = [];
          resolve();
        };
      });
    });
    const view = await mount();
    await waitFor(() => texts(view).includes('MacBook'));

    await press(rowAction(view, 'Remove'));
    expect(alertSpy).toHaveBeenCalledOnce();
    expect(alertSpy.mock.calls[0]?.[0]).toBe('Remove passkey?');
    expect(alertSpy.mock.calls[0]?.[2]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ style: 'destructive', text: 'Remove passkey' }),
      ])
    );

    // Removed optimistically, before the server answered: with no row left, the
    // empty state is the surface.
    await confirmRemoval(alertSpy);
    await waitFor(() => nodes(view, 'EmptyState').length === 1);
    expect(texts(view)).not.toContain('MacBook');

    await act(() => {
      releaseDelete?.();
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
    await confirmRemoval(alertSpy);

    // The row is back, the failure is inline beside it, and the toast carries
    // the server's own message.
    await waitFor(() => texts(view).includes('Could not remove that passkey. Try again.'));
    expect(texts(view)).toContain('MacBook');
    expect(toastError).toHaveBeenCalledWith('nope');

    await press(buttonByLabel(view, 'Retry'));
    expect(list.deleteFn).toHaveBeenCalledTimes(2);
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

  it('adds a passkey, toasts, and refreshes the list', async () => {
    store.rows = [];
    const view = await mount();
    await waitFor(() => nodes(view, 'EmptyState').length === 1);

    await press(buttonByLabel(view, 'Add a passkey'));
    await waitFor(() => toastSuccess.mock.calls.length > 0);

    expect(list.register).toHaveBeenCalledOnce();
    expect(toastSuccess).toHaveBeenCalledWith('Passkey added.');
    expect(list.queryFn.mock.calls.length).toBeGreaterThan(1);
    view.unmount();
  });

  it('hides the Add control and names the reason on a device that cannot create passkeys', async () => {
    list.supported.mockReturnValue(false);
    const view = await mount();
    await waitFor(() => texts(view).includes('MacBook'));

    // The device can never create one, so the notice stands alone and the
    // existing passkeys still list.
    expect(texts(view)).toContain('This device cannot create passkeys.');
    expect(hasButtonLabel(view, 'Add a passkey')).toBe(false);
    expect(hasButtonLabel(view, 'Retry')).toBe(false);
    expect(texts(view)).toContain('Passkey');
    expect(nodes(view, 'KeyRound')).toHaveLength(2);
    view.unmount();
  });

  it('shows the unsupported notice instead of creation when there are no passkeys and the device cannot create them', async () => {
    store.rows = [];
    list.supported.mockReturnValue(false);
    const view = await mount();
    await waitFor(() => nodes(view, 'EmptyState').length === 1);

    const empty = first(view, 'EmptyState');
    // The creation hint would name the Add control this device cannot offer, so
    // the notice is the description and the state has no action at all.
    expect(emptyDescription(view)).toBe('This device cannot create passkeys.');
    expect(empty.props.action).toBeUndefined();
    expect(hasButtonLabel(view, 'Add a passkey')).toBe(false);
    view.unmount();
  });

  it('drops the Add control when the ceremony refuses as unsupported', async () => {
    store.rows = [];
    list.register.mockResolvedValue({ status: 'error', failure: 'unsupported' });
    const view = await mount();
    await waitFor(() => nodes(view, 'EmptyState').length === 1);

    await press(buttonByLabel(view, 'Add a passkey'));
    await waitFor(() => !hasButtonLabel(view, 'Add a passkey'));

    // Non-retryable: no retry control, and no Add control that could only fail
    // the same way again. The notice replaces the hint the control annotated.
    expect(hasButtonLabel(view, 'Retry')).toBe(false);
    expect(emptyDescription(view)).toBe('This device cannot create passkeys.');
    view.unmount();
  });

  it('keeps the Add CTA and names the reason when creation fails retryably', async () => {
    store.rows = [];
    list.register.mockResolvedValue({ status: 'error', failure: 'failed' });
    const view = await mount();
    await waitFor(() => nodes(view, 'EmptyState').length === 1);

    await press(buttonByLabel(view, 'Add a passkey'));
    await waitFor(() => texts(view).includes('Could not add a passkey. Try again.'));

    // Retryable: the same control starts a fresh ceremony.
    expect(hasButtonLabel(view, 'Add a passkey')).toBe(true);
    view.unmount();
  });

  it('leaves the list unchanged and toasts when the creation sheet is cancelled', async () => {
    list.register.mockResolvedValue({ status: 'error', failure: 'cancelled' });
    const view = await mount();
    await waitFor(() => texts(view).includes('MacBook'));

    await press(buttonByLabel(view, 'Add a passkey'));
    await waitFor(() => toastError.mock.calls.length > 0);

    expect(toastError).toHaveBeenCalledWith('Passkey creation was cancelled.');
    expect(texts(view)).toContain('MacBook');
    expect(texts(view)).toContain('Passkey');
    expect(nodes(view, 'KeyRound')).toHaveLength(2);
    view.unmount();
  });

  it('renames through the modal with the current name prefilled', async () => {
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
    expect(list.renameFn.mock.calls[0]?.[0]).toEqual({ id: 'pk-1', name: 'Work laptop' });
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
      await expect(
        (modal.props.onSave as (name: string) => Promise<void>)('Work laptop')
      ).rejects.toThrow('nope');
    });

    expect(toastError).toHaveBeenCalledWith('nope');
    view.unmount();
  });

  it('locks the removal retry while the retried delete is in flight', async () => {
    let releaseRetry: (() => void) | undefined = undefined;
    // Two passkeys, so the retried delete's optimistic removal leaves a row
    // beside the failure notice instead of emptying the list under it.
    list.deleteFn.mockRejectedValueOnce(new Error('nope'));
    const view = await mount();
    await waitFor(() => texts(view).includes('MacBook'));

    await press(rowAction(view, 'Remove'));
    await confirmRemoval(alertSpy);
    await waitFor(() => texts(view).includes('Could not remove that passkey. Try again.'));

    // The retried delete is now in flight. While it is, the control must not be
    // startable again: a second tap would send a concurrent delete of the same
    // id whose rollback could hide a passkey the server still has.
    list.deleteFn.mockImplementation(async () => {
      await new Promise<void>(resolve => {
        releaseRetry = resolve;
      });
    });
    await press(buttonByLabel(view, 'Retry'));
    await waitFor(() => buttonByLabel(view, 'Retry').props.loading === true);

    const retryButton = buttonByLabel(view, 'Retry');
    // The real Button sets `disabled` from `loading` (button.tsx), so the
    // control cannot be tapped again until this delete settles.
    expect(retryButton.props.loading).toBe(true);
    expect(list.deleteFn).toHaveBeenCalledTimes(2);

    await act(() => {
      releaseRetry?.();
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
    await confirmRemoval(alertSpy);
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
