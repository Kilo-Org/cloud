import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  action,
  BUTTON,
  mount,
  resetState,
  screenState as state,
  texts,
  unmountBlockedPeople,
} from './blocked-people-screen.test-helpers';
import { act } from '@/test/renderer';

beforeEach(() => {
  resetState();
});

afterEach(() => {
  unmountBlockedPeople();
});

describe('BlockedPeopleScreen', () => {
  it('separates blocked people from muted people', async () => {
    const root = await mount();

    expect(texts(root)).toEqual(
      expect.arrayContaining(['Blocked people', 'Muted people', 'spammer', 'loudmouth'])
    );
  });

  it('unblocks a login directly, without a confirmation', async () => {
    const root = await mount();

    act(() => {
      (action(root, 'Unblock spammer').props.onPress as () => void)();
    });

    expect(state.calls).toEqual([{ name: 'unblock', input: { githubLogin: 'spammer' } }]);
  });

  it('unmutes a login directly', async () => {
    const root = await mount();

    act(() => {
      (action(root, 'Unmute loudmouth').props.onPress as () => void)();
    });

    expect(state.calls).toEqual([{ name: 'unmute', input: { githubLogin: 'loudmouth' } }]);
  });

  it('keeps each list independent while a reveal is in flight', async () => {
    state.pending = 'unblock';
    state.pendingVariables = { githubLogin: 'spammer' };
    const root = await mount();

    expect(action(root, 'Unblock spammer').props.disabled).toBe(true);
    expect(action(root, 'Unmute loudmouth').props.disabled).toBe(false);

    unmountBlockedPeople();

    state.pending = 'unmute';
    state.pendingVariables = { githubLogin: 'loudmouth' };
    const second = await mount();

    expect(action(second, 'Unblock spammer').props.disabled).toBe(false);
    expect(action(second, 'Unmute loudmouth').props.disabled).toBe(true);
  });

  it('ignores a second tap in the same list while the first is pending', async () => {
    state.blockedLogins = ['spammer', 'second-blocked'];
    state.pending = 'unblock';
    state.pendingVariables = { githubLogin: 'spammer' };
    const root = await mount();

    expect(action(root, 'Unblock spammer').props.disabled).toBe(true);
    expect(action(root, 'Unblock second-blocked').props.disabled).toBe(true);
    expect(action(root, 'Unblock second-blocked').props.loading).toBe(false);
    expect(action(root, 'Unmute loudmouth').props.disabled).toBe(false);
  });

  it('shows the server message when a reveal is refused', async () => {
    await mount();

    act(() => {
      state.mutations.unblock?.onSettled?.();
      state.mutations.unblock?.onError?.(new Error('That account is no longer hidden'));
    });

    expect(state.toastError).toHaveBeenCalledWith('That account is no longer hidden');
  });

  it('has one empty state when nobody is hidden', async () => {
    state.blockedLogins = [];
    state.mutedLogins = [];
    const root = await mount();

    expect(
      root.findAll(node => Object.is(node.type, 'EmptyState')).map(node => node.props.title)
    ).toEqual(['Nobody is hidden']);
    expect(root.findAll(node => Object.is(node.type, BUTTON))).toHaveLength(0);
  });

  it('keeps a full retry state when the lists cannot be read at all', async () => {
    state.hasData = false;
    state.error = true;
    const root = await mount();

    expect(root.findAll(node => Object.is(node.type, 'QueryError'))).toHaveLength(1);
    expect(texts(root)).not.toContain('spammer');
  });

  it('keeps rows and adds an error notice when a refetch fails with cache', async () => {
    state.error = true;
    const root = await mount();

    expect(texts(root)).toEqual(expect.arrayContaining(['spammer', 'loudmouth']));
    const notices = root.findAll(node => Object.is(node.type, 'QueryError'));
    expect(notices).toHaveLength(1);
    expect(notices[0]?.props.onRetry).toBeTypeOf('function');
  });

  it('settles the hidden-people read while the app reports offline', async () => {
    // The default `networkMode: 'online'` would pause in `pending` while the
    // online manager reports offline: no rows, no error, no retry.
    await mount();

    expect(state.lastQueryOptions).toMatchObject({
      networkMode: 'always',
      refetchOnReconnect: true,
    });
  });

  it('names the connection when a cached empty list fails to refresh offline', async () => {
    // The read settles (`networkMode: 'always'`), so a failure the server never
    // answered lands as an error over the cache; the notice names the
    // connection and the empty state stays visible beneath it.
    state.blockedLogins = [];
    state.mutedLogins = [];
    state.error = true;
    state.connectivity = 'offline';
    const root = await mount();

    const notice = root.find(node => Object.is(node.type, 'QueryError'));
    expect(notice.props.variant).toBe('offline');
    expect(notice.props.onRetry).toBeTypeOf('function');
    expect(root.findAll(node => Object.is(node.type, 'EmptyState'))).toHaveLength(1);
    expect(root.findAll(node => Object.is(node.type, 'Skeleton'))).toHaveLength(0);
  });

  it('names the connection for a failure that never reached the server', async () => {
    // Connectivity is still unsettled, but a transport error carries no
    // server answer, so the failure is the connection's all the same.
    state.error = true;
    state.connectivity = 'unknown';
    const root = await mount();

    const notice = root.find(node => Object.is(node.type, 'QueryError'));
    expect(notice.props.variant).toBe('offline');
    expect(notice.props.onRetry).toBeTypeOf('function');
  });

  it('reports a coded refresh failure as the server failure it is', async () => {
    state.error = true;
    state.errorCode = 'INTERNAL_SERVER_ERROR';
    const root = await mount();

    const notice = root.find(node => Object.is(node.type, 'QueryError'));
    expect(notice.props.variant).toBe('server');
    expect(notice.props.onRetry).toBeTypeOf('function');
  });

  it('reports a refused refresh without an offer to retry', async () => {
    state.error = true;
    state.errorCode = 'FORBIDDEN';
    const root = await mount();

    const notice = root.find(node => Object.is(node.type, 'QueryError'));
    expect(notice.props.variant).toBe('permission');
    expect(notice.props.onRetry).toBeUndefined();
  });

  it('keeps the stale notice mounted while its retry runs', async () => {
    // A notice gated on `!isFetching` would unmount on the tap that starts the
    // retry, so the reader saw the notice vanish instead of its spinner.
    state.error = true;
    const idle = await mount();
    expect(idle.find(node => Object.is(node.type, 'QueryError')).props.isRetrying).toBe(false);

    state.isFetching = true;
    const retrying = await mount();
    const notice = retrying.find(node => Object.is(node.type, 'QueryError'));
    expect(notice.props.isRetrying).toBe(true);
    expect(notice.props.onRetry).toBeTypeOf('function');
  });

  it('names the offline failure of a first load instead of the skeleton', async () => {
    state.hasData = false;
    state.error = true;
    state.connectivity = 'offline';
    const root = await mount();

    const errors = root.findAll(node => Object.is(node.type, 'QueryError'));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.props.variant).toBe('offline');
    expect(errors[0]?.props.onRetry).toBeTypeOf('function');
    expect(root.findAll(node => Object.is(node.type, 'Skeleton'))).toHaveLength(0);
  });

  it('keeps the skeleton for a first load still in flight', async () => {
    state.hasData = false;
    const root = await mount();

    expect(root.findAll(node => Object.is(node.type, 'QueryError'))).toHaveLength(0);
    expect(root.findAll(node => Object.is(node.type, 'Skeleton'))).not.toHaveLength(0);
  });

  it('offers pull to refresh wired to the read refetch', async () => {
    await mount();
    expect(state.lastRefreshControl).toBeTruthy();
    const control = state.lastRefreshControl;
    if (!control) {
      throw new Error('refresh control missing');
    }
    expect(control.props.refreshing).toBe(false);
    expect(control.props.onRefresh).toBeTypeOf('function');
    state.isRefetching = true;
    const refreshing = await mount();
    expect(state.lastRefreshControl?.props.refreshing).toBe(true);
    expect(refreshing.findAll(node => Object.is(node.type, 'QueryError'))).toHaveLength(0);
  });
});
