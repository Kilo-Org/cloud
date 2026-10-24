import {
  first,
  hasButtonLabel,
  list,
  mount,
  nodes,
  store,
  windowSize,
} from './passkeys-screen.test-helpers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@/test/render-with-providers';

beforeEach(() => {
  vi.clearAllMocks();
  windowSize.width = 411;
  windowSize.height = 914;
  store.rows = [];
  list.supported.mockReturnValue(true);
  list.queryFn.mockImplementation(() => ({ success: true, passkeys: store.rows }));
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('PasskeysScreen empty state in a short window', () => {
  it('keeps the icon bubble above the copy in portrait', async () => {
    const view = await mount();
    await waitFor(() => nodes(view, 'EmptyState').length === 1);

    const empty = first(view, 'EmptyState');
    expect(empty.props.compact).toBe(false);
    expect(empty.props.title).toBe('No passkeys yet');
    expect(hasButtonLabel(view, 'Add a passkey')).toBe(true);
    view.unmount();
  });

  it('drops the decoration when the window is a phone held sideways', async () => {
    // The footer above the tab bar owns most of a landscape window, so the
    // empty state's band is shorter than the bubble plus the copy: the title
    // and the hint would start below the fold.
    windowSize.width = 914;
    windowSize.height = 411;
    const view = await mount();
    await waitFor(() => nodes(view, 'EmptyState').length === 1);

    const empty = first(view, 'EmptyState');
    expect(empty.props.compact).toBe(true);
    expect(empty.props.title).toBe('No passkeys yet');
    expect(empty.props.description).toBe('Add a passkey to sign in without a password.');
    expect(hasButtonLabel(view, 'Add a passkey')).toBe(true);
    view.unmount();
  });

  it('keeps the full stack for a tablet in landscape', async () => {
    windowSize.width = 1024;
    windowSize.height = 600;
    const view = await mount();
    await waitFor(() => nodes(view, 'EmptyState').length === 1);

    expect(first(view, 'EmptyState').props.compact).toBe(false);
    view.unmount();
  });
});
