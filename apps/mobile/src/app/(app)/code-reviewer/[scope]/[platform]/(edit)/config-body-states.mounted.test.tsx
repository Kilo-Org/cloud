/* eslint-disable max-lines -- one harness mounts the four config-drawing edit screens */

// The config-drawing edit screens must handle every state of the reviewer
// config read, not only `data`. Before this suite they branched on
// `data == null` alone: a failed or paused read left the gate and style rows
// disabled with no explanation, and focus-areas offered no way back. Each one
// now paints the shared retryable error instead.

import { createElement, type ReactElement, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { i18n } from '@/i18n';

import FocusAreasRoute from './focus-areas';
import GateThresholdRoute from './gate';
import ReviewStyleRoute from './style';

type ConfigState = {
  data: { gateThreshold?: string; reviewStyle?: string; focusAreas?: string[] } | null;
  isError: boolean;
  isFetching: boolean;
  fetchStatus: string;
  refetch: Mock;
};

const config = vi.hoisted((): ConfigState => ({
  data: null,
  isError: false,
  isFetching: false,
  fetchStatus: 'idle',
  refetch: vi.fn(),
}));
const connectivity = vi.hoisted(() => ({ known: true }));
const optionList = vi.hoisted(() => ({
  titles: [] as string[],
  disabled: [] as boolean[],
  selected: [] as (string | undefined)[],
}));
const errorScreen = vi.hoisted(() => ({
  props: [] as { title?: string; variant?: string; onRetry?: () => void; isRetrying?: boolean }[],
}));
const queryError = vi.hoisted(() => ({
  props: [] as { variant?: string; onRetry?: () => void; isRetrying?: boolean }[],
}));
const choiceRows = vi.hoisted(() => ({
  rows: [] as { label: string; selected: boolean; disabled?: boolean }[],
}));

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@/lib/hooks/use-reviewer-route-params', () => ({
  useReviewerRouteParams: () => ({ scope: 'personal', platform: 'github' }),
}));
vi.mock('@/components/invalid-route-state', () => ({ InvalidRouteState: 'InvalidRouteState' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/tab-screen', () => ({
  TabScreenScrollView: (props: { children?: ReactNode }) =>
    createElement('ScrollView', null, props.children),
}));
vi.mock('@/components/ui/choice-row', () => ({
  ChoiceRow: (props: { label: string; selected: boolean; disabled?: boolean }): ReactNode => {
    choiceRows.rows.push(props);
    return createElement('ChoiceRow', props);
  },
}));
vi.mock('@/components/code-reviewer/option-list', () => ({
  OptionList: (props: { title: string; selected?: string; disabled?: boolean }): ReactNode => {
    optionList.titles.push(props.title);
    optionList.disabled.push(Boolean(props.disabled));
    optionList.selected.push(props.selected);
    return createElement('OptionList', props);
  },
}));
vi.mock('@/components/platform-error-screen', () => ({
  PlatformErrorScreen: (props: {
    title?: string;
    variant?: string;
    onRetry?: () => void;
    isRetrying?: boolean;
  }): ReactNode => {
    errorScreen.props.push(props);
    return createElement('PlatformErrorScreen', props);
  },
}));
vi.mock('@/components/query-error', () => ({
  QueryError: (props: {
    variant?: string;
    onRetry?: () => void;
    isRetrying?: boolean;
  }): ReactNode => {
    queryError.props.push(props);
    return createElement('QueryError', props);
  },
}));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  useCommittedConnectivityStatus: () => (connectivity.known ? 'online' : 'unknown'),
}));
vi.mock('@/lib/hooks/use-code-reviewer', () => ({
  useReviewConfig: () => config,
  useSaveReviewConfig: () => ({ mutate: vi.fn() }),
  useReviewConfigCacheReader: () => () => config.data,
}));

function mount(route: ReactElement): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(route);
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('route did not render');
  }
  return renderer;
}

function last<T>(values: T[]): T | undefined {
  return values.at(-1);
}

beforeEach(() => {
  config.data = null;
  config.isError = false;
  config.isFetching = false;
  config.fetchStatus = 'idle';
  config.refetch.mockReset();
  connectivity.known = true;
  optionList.titles = [];
  optionList.disabled = [];
  optionList.selected = [];
  errorScreen.props = [];
  queryError.props = [];
  choiceRows.rows = [];
});

afterEach(async () => {
  vi.useRealTimers();
  await act(async () => {
    await i18n.changeLanguage('en');
  });
});

describe('gate threshold screen config states', () => {
  it('shows the retryable error instead of disabled rows when the load fails', () => {
    config.isError = true;
    mount(createElement(GateThresholdRoute));

    expect(optionList.titles).toHaveLength(0);
    expect(last(errorScreen.props)?.title).toBe(i18n.t('codeReviewer.gate.title'));
    expect(last(errorScreen.props)?.variant).toBe('server');
  });

  it('names the confirmed-offline pause as the reason the load stopped', () => {
    config.fetchStatus = 'paused';
    mount(createElement(GateThresholdRoute));

    expect(optionList.titles).toHaveLength(0);
    expect(last(errorScreen.props)?.variant).toBe('offline');
  });

  it('retries the config read from the error state', () => {
    config.isError = true;
    mount(createElement(GateThresholdRoute));

    act(() => {
      last(errorScreen.props)?.onRetry?.();
    });

    expect(config.refetch).toHaveBeenCalledTimes(1);
  });

  it('draws the rows with the stored threshold once the config lands', () => {
    config.data = { gateThreshold: 'warning' };
    mount(createElement(GateThresholdRoute));

    expect(last(errorScreen.props)).toBeUndefined();
    expect(last(optionList.titles)).toBe(i18n.t('codeReviewer.gate.title'));
    expect(last(optionList.disabled)).toBe(false);
    expect(last(optionList.selected)).toBe('warning');
  });

  it('keeps the rows disabled while the first load is in flight', () => {
    config.fetchStatus = 'fetching';
    mount(createElement(GateThresholdRoute));

    expect(last(errorScreen.props)).toBeUndefined();
    expect(last(optionList.disabled)).toBe(true);
  });
});

describe('review style screen config states', () => {
  it('shows the retryable error instead of disabled rows when the load fails', () => {
    config.isError = true;
    mount(createElement(ReviewStyleRoute));

    expect(optionList.titles).toHaveLength(0);
    expect(last(errorScreen.props)?.title).toBe(i18n.t('codeReviewer.style.title'));
    expect(last(errorScreen.props)?.variant).toBe('server');
  });

  it('draws the rows with the stored style once the config lands', () => {
    config.data = { reviewStyle: 'strict' };
    mount(createElement(ReviewStyleRoute));

    expect(last(errorScreen.props)).toBeUndefined();
    expect(last(optionList.disabled)).toBe(false);
    expect(last(optionList.selected)).toBe('strict');
  });
});

describe('focus areas screen config states', () => {
  it('shows the retryable error instead of disabled rows when the load fails', () => {
    config.isError = true;
    const renderer = mount(createElement(FocusAreasRoute));

    expect(choiceRows.rows).toHaveLength(0);
    expect(last(queryError.props)?.variant).toBe('server');
    expect(renderer.root.findAll(node => String(node.type) === 'QueryError')).toHaveLength(1);
  });

  it('retries the config read from the error state', () => {
    config.isError = true;
    mount(createElement(FocusAreasRoute));

    act(() => {
      last(queryError.props)?.onRetry?.();
    });

    expect(config.refetch).toHaveBeenCalledTimes(1);
  });

  it('offers Retry when the idle read cannot be restarted', async () => {
    vi.useFakeTimers();
    const renderer = mount(createElement(FocusAreasRoute));

    // Pending with nothing in flight: the one automatic restart runs, leaves
    // the read exactly as idle, and the body stops waiting behind disabled
    // rows.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });

    expect(config.refetch).toHaveBeenCalledTimes(1);
    expect(last(queryError.props)?.variant).toBe('server');
    expect(renderer.root.findAll(node => String(node.type) === 'ChoiceRow')).toHaveLength(0);
  });

  it('draws the selectable areas once the config lands', () => {
    config.data = { focusAreas: ['security'] };
    mount(createElement(FocusAreasRoute));

    expect(last(queryError.props)).toBeUndefined();
    const security = choiceRows.rows.find(row => row.selected);
    expect(security?.disabled).toBe(false);
  });
});
