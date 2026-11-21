// The screen's read states, each named by its own cause: a first config read the
// online manager paused, a role read that failed or is paused, and a model
// catalogue that failed or delivered nothing to pick from. PlatformErrorScreen
// is mounted unmocked, so the paused branch is asserted through the real
// screen's contract with QueryError.

// The helper import is first: its vi.mock registrations must be in place
// before any other import evaluates.
import {
  capability,
  catalog,
  config,
  connectivity,
  depthSegmentsLocked,
  enabledConfig,
  failureScreens,
  hostElements,
  mountFor,
  paints,
  pausedRetry,
  recoveryCards,
  settingsRecovery,
  unmountAll,
} from './analysis-settings-screen.states.mounted.test-helpers';

import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';
import { AnalysisSettingsScreen } from './analysis-settings-screen';

// The helper owns the mount itself, so the suite never re-registers mocks; it
// binds the one screen element every case mounts.
const mount = mountFor(createElement(AnalysisSettingsScreen, { scope: 'personal' }));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  capability.status = 'allowed';
  capability.isPending = false;
  capability.fetchStatus = 'idle';
  config.data = undefined;
  config.isLoading = false;
  config.isError = false;
  config.isPending = false;
  config.error = null;
  config.fetchStatus = 'idle';
  config.refetch.mockReset();
  pausedRetry.retry.mockReset();
  pausedRetry.isRetrying = false;
  settingsRecovery.retry.mockReset();
  settingsRecovery.isRetrying = false;
  recoveryCards.props = [];
  failureScreens.props = [];
  connectivity.status = 'online';
  catalog.models = [];
  catalog.isError = false;
  catalog.error = undefined;
  catalog.isLoading = false;
  catalog.isFetched = false;
  catalog.isFetching = false;
  catalog.hasDeliveredData = false;
  catalog.fetchStatus = 'idle';
  catalog.refetch.mockReset();
});

afterEach(() => {
  unmountAll();
});

describe('AnalysisSettingsScreen paused first config read', () => {
  it('names the connection and retries the paused read instead of refetching it plain', async () => {
    // The online manager paused the cold read on a confirmed-offline device:
    // pending, no data, no error. The loading gate would hold the skeleton
    // until connectivity returns.
    config.isPending = true;
    config.fetchStatus = 'paused';
    connectivity.status = 'offline';

    await mount();

    expect(failureScreens.props).toHaveLength(1);
    const screen = failureScreens.props[0];
    expect(screen?.variant).toBe('offline');
    expect(screen?.title).toBe(i18n.t('securityAgent.analysisSettings.couldNotLoad'));
    screen?.onRetry?.();
    expect(pausedRetry.retry).toHaveBeenCalledOnce();
    expect(config.refetch).not.toHaveBeenCalled();
  });

  it('keeps the skeleton while a pause cannot be attributed to the connection yet', async () => {
    // The manager also pauses on an unsettled NetInfo report, which is the
    // normal cold-launch window: that is not a connection failure yet.
    config.isPending = true;
    config.fetchStatus = 'paused';
    connectivity.status = 'unknown';

    const { renderer } = await mount();

    expect(failureScreens.props).toHaveLength(0);
    expect(hostElements(renderer, 'Skeleton').length).toBeGreaterThan(0);
  });

  it("carries the paused retry hook's busy state into the failure screen", async () => {
    config.isPending = true;
    config.fetchStatus = 'paused';
    connectivity.status = 'offline';
    pausedRetry.isRetrying = true;

    await mount();

    expect(failureScreens.props[0]?.isRetrying).toBe(true);
  });
});

describe('AnalysisSettingsScreen model catalogue states', () => {
  it('shows one retryable failure and no pickable row when the read delivered nothing', async () => {
    config.data = enabledConfig();
    catalog.isError = true;
    catalog.error = new TypeError('Network request failed');

    const { renderer } = await mount();

    expect(failureScreens.props).toHaveLength(1);
    expect(failureScreens.props[0]?.title).toBe(i18n.t('common.couldNotLoadModels'));
    expect(hostElements(renderer, 'ConfigureRow')).toHaveLength(0);
  });

  it('keeps the failure and its Retry through the retry request itself', async () => {
    // v5 downgrades a no-data refetch back to pending and clears `error`, so
    // `isError` alone would swap the failure block for the empty notice while
    // the Retry it started is still in flight.
    config.data = enabledConfig();
    catalog.isError = false;
    catalog.error = undefined;
    catalog.isLoading = true;
    catalog.isFetched = true;
    catalog.isFetching = true;

    const { renderer } = await mount();

    expect(failureScreens.props).toHaveLength(1);
    expect(failureScreens.props[0]?.title).toBe(i18n.t('common.couldNotLoadModels'));
    expect(paints(renderer, i18n.t('common.noModelsAvailable'))).toBe(false);
    expect(hostElements(renderer, 'ConfigureRow')).toHaveLength(0);
  });

  it('keeps the rows but disables them under one notice for a delivered empty catalogue', async () => {
    // A delivered empty catalogue is not a failure, and it is not a choice
    // either: the setting still reads as a setting, with nothing to pick.
    config.data = enabledConfig();
    catalog.models = [];
    catalog.isFetched = true;
    catalog.hasDeliveredData = true;

    const { renderer } = await mount();

    const rows = hostElements(renderer, 'ConfigureRow');
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.props.disabled).toBe(true);
    }
    expect(paints(renderer, i18n.t('common.noModelsAvailable'))).toBe(true);
    expect(failureScreens.props).toHaveLength(0);
  });
});

describe('AnalysisSettingsScreen role read states', () => {
  it('offers a retry for the settings set when the role read failed, without locking the controls', async () => {
    // A failed role read is not evidence that the viewer cannot manage the
    // settings, so the controls stay live under the recovery row.
    config.data = enabledConfig();
    capability.status = 'error';

    const { renderer } = await mount();

    expect(recoveryCards.props).toHaveLength(1);
    expect(recoveryCards.props[0]?.message).toBe(
      i18n.t('securityAgent.settingsOverview.couldNotLoadPermissions')
    );
    expect(recoveryCards.props[0]?.isRetrying).toBe(false);
    recoveryCards.props[0]?.onRetry();
    expect(settingsRecovery.retry).toHaveBeenCalledOnce();
    expect(depthSegmentsLocked(renderer)).toEqual([false, false, false]);
    expect(paints(renderer, i18n.t('securityAgent.sla.permissionNote'))).toBe(false);
  });

  it('locks the controls and says why once the role read settles as a denial', async () => {
    config.data = enabledConfig();
    capability.status = 'denied';

    const { renderer } = await mount();

    expect(recoveryCards.props).toHaveLength(0);
    expect(depthSegmentsLocked(renderer)).toEqual([true, true, true]);
    expect(paints(renderer, i18n.t('securityAgent.sla.permissionNote'))).toBe(true);
  });

  it('paints no recovery row for a role read that is simply still in flight', async () => {
    // A plain in-flight role read has not answered yet; an error card there
    // would claim a failure the read never reported.
    config.data = enabledConfig();
    capability.status = 'loading';
    capability.isPending = true;
    capability.fetchStatus = 'fetching';

    const { renderer } = await mount();

    expect(recoveryCards.props).toHaveLength(0);
    expect(depthSegmentsLocked(renderer)).toEqual([false, false, false]);
  });
});
