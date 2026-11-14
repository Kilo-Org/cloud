import {
  accessibilityLabels,
  buttonByLabel,
  first,
  hasButtonLabel,
  list,
  MACBOOK,
  mount,
  nodes,
  press,
  retry,
  store,
  texts,
  UNNAMED,
  USED,
} from './passkeys-screen.test-helpers';
import { act } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@/test/render-with-providers';

/** The one notice this screen shows: passkeys are managed in a browser. */
const MANAGE_IN_BROWSER = 'Passkeys can be added, renamed, and removed in a web browser.';

beforeEach(() => {
  vi.clearAllMocks();
  store.rows = [MACBOOK, UNNAMED];
  list.queryFn.mockImplementation(() => ({ success: true, passkeys: store.rows }));
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('PasskeysScreen', () => {
  it('shows skeleton rows sized like the final rows while loading', async () => {
    list.queryFn.mockImplementation(async () => {
      await new Promise(() => undefined);
    });
    const view = await mount();

    // One tile and two text lines per reserved row.
    expect(nodes(view, 'Skeleton')).toHaveLength(9);
    // A row has no control to reserve: a loaded row is the same height as its
    // skeleton, so the list does not jump on load.
    expect(
      nodes(view, 'View').filter(node => String(node.props.className).includes('min-h-[44px]'))
    ).toHaveLength(0);
    expect(nodes(view, 'EmptyState')).toHaveLength(0);
    view.unmount();
  });

  it('lists a row per passkey with its name, default name and created date', async () => {
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
    // Only the recorded-use row carries the line; a credential the server has
    // never seen used keeps the name-and-added pair.
    expect(texts(view).filter(text => text === 'Last used Jan 1, 2026')).toHaveLength(1);
    view.unmount();
  });

  it('shows the empty state with no action and no description when there are no passkeys', async () => {
    store.rows = [];
    const view = await mount();
    await waitFor(() => nodes(view, 'EmptyState').length === 1);

    const empty = first(view, 'EmptyState');
    expect(empty.props.title).toBe('No passkeys yet');
    // The notice above the list is the whole explanation, so the state repeats
    // neither it nor a creation action this app cannot perform.
    expect(empty.props.description).toBeUndefined();
    expect(empty.props.action).toBeUndefined();
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

  it('says beside the rows that passkeys are managed in a web browser', async () => {
    const view = await mount();
    await waitFor(() => texts(view).includes('MacBook'));

    expect(texts(view)).toContain(MANAGE_IN_BROWSER);
    expect(nodes(view, 'KeyRound')).toHaveLength(2);
    view.unmount();
  });

  it('says the same in the empty state', async () => {
    store.rows = [];
    const view = await mount();
    await waitFor(() => nodes(view, 'EmptyState').length === 1);

    expect(texts(view)).toContain(MANAGE_IN_BROWSER);
    view.unmount();
  });

  it('offers no rename, remove or add control in either the rows or the empty state', async () => {
    const view = await mount();
    await waitFor(() => texts(view).includes('MacBook'));

    // Management is a browser-session operation, so no row control and no Add
    // action may exist anywhere in the tree.
    expect(accessibilityLabels(view)).not.toContain('Rename');
    expect(accessibilityLabels(view)).not.toContain('Remove');
    expect(hasButtonLabel(view, 'Add a passkey')).toBe(false);
    expect(texts(view)).not.toContain('Add a passkey');
    view.unmount();

    store.rows = [];
    const emptyView = await mount();
    await waitFor(() => nodes(emptyView, 'EmptyState').length === 1);

    expect(accessibilityLabels(emptyView)).not.toContain('Rename');
    expect(accessibilityLabels(emptyView)).not.toContain('Remove');
    expect(hasButtonLabel(emptyView, 'Add a passkey')).toBe(false);
    expect(texts(emptyView)).not.toContain('Add a passkey');
    emptyView.unmount();
  });
});
