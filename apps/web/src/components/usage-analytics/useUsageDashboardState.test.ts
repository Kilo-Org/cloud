/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires -- the DOM globals and Jest mocks must exist before the hook module loads. */
import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { OrganizationUsageView } from './types';
import type {
  DashboardState,
  useUsageDashboardState as UseUsageDashboardState,
} from './useUsageDashboardState';

const mockReplace = jest.fn<(url: string, options?: { scroll?: boolean }) => void>();
let mockSearch = '';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace }),
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

type LinkedomParseHtml = (html: string) => { window: typeof globalThis; document: Document };

const requireFromNext = createRequire(createRequire(__filename).resolve('next/package.json'));
const { parseHTML } = requireFromNext('linkedom') as { parseHTML: LinkedomParseHtml };
const { window: domWindow, document: domDocument } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);

const ORIGIN = 'https://app.test';
const PATHNAME = '/organizations/org-1/usage-details';
const fakeLocation = { origin: ORIGIN, pathname: PATHNAME, search: '' };
Object.defineProperty(domWindow, 'location', { configurable: true, value: fakeLocation });

const previousGlobals = {
  window: globalThis.window,
  document: globalThis.document,
  HTMLElement: globalThis.HTMLElement,
  Element: globalThis.Element,
  Node: globalThis.Node,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT,
};

const pendingFrames: FrameRequestCallback[] = [];

Object.assign(globalThis, {
  window: domWindow,
  document: domDocument,
  HTMLElement: domWindow.HTMLElement,
  Element: domWindow.Element,
  Node: domWindow.Node,
  requestAnimationFrame: (callback: FrameRequestCallback) => {
    pendingFrames.push(callback);
    return pendingFrames.length;
  },
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { useUsageDashboardState } = require('./useUsageDashboardState') as {
  useUsageDashboardState: typeof UseUsageDashboardState;
};

type HookOptions = {
  defaultState?: Partial<DashboardState>;
  allowedViews?: readonly OrganizationUsageView[];
};

let latest: ReturnType<typeof UseUsageDashboardState> | undefined;

function StateProbe({ defaultState, allowedViews }: HookOptions) {
  latest = useUsageDashboardState(defaultState, allowedViews ? { allowedViews } : undefined);
  return null;
}

const COMPLETE_OPTIONS: HookOptions = {
  defaultState: { usageView: 'ai-usage' },
  allowedViews: ['ai-usage'],
};

function currentView(): OrganizationUsageView {
  if (!latest) throw new Error('Hook has not rendered');
  return latest.state.usageView;
}

function flushFrames(): void {
  for (const callback of pendingFrames.splice(0)) callback(Date.now());
}

function navigateBack(search: string): void {
  fakeLocation.search = search;
  mockSearch = search;
  act(() => {
    domWindow.dispatchEvent(new domWindow.Event('popstate'));
  });
  act(() => {
    flushFrames();
  });
}

function lastReplacedParams(): URLSearchParams {
  const call = mockReplace.mock.calls.at(-1);
  if (!call) throw new Error('router.replace was not called');
  return new URL(call[0]).searchParams;
}

describe('useUsageDashboardState view clamping', () => {
  let root: Root;

  function mount(search: string, options: HookOptions = {}): void {
    mockSearch = search;
    fakeLocation.search = search;
    const container = domDocument.getElementById('root');
    if (!container) throw new Error('Missing useUsageDashboardState test root');
    act(() => {
      root = createRoot(container);
    });
    act(() => {
      root.render(createElement(StateProbe, options));
    });
  }

  beforeEach(() => {
    latest = undefined;
    pendingFrames.length = 0;
    mockReplace.mockClear();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
  });

  afterAll(() => {
    Object.assign(globalThis, previousGlobals);
  });

  it.each(['?view=overview', '?view=feature-adoption', '', '?view=bogus'])(
    'opens AI usage for a complete org on first load with %p',
    search => {
      mount(search, COMPLETE_OPTIONS);
      expect(currentView()).toBe('ai-usage');
    }
  );

  it('clamps back/forward navigation to AI usage for a complete org', () => {
    mount('?view=ai-usage', COMPLETE_OPTIONS);
    expect(currentView()).toBe('ai-usage');

    navigateBack('?view=feature-adoption');
    expect(currentView()).toBe('ai-usage');

    navigateBack('?view=overview');
    expect(currentView()).toBe('ai-usage');

    navigateBack('?period=7d');
    expect(currentView()).toBe('ai-usage');
    expect(latest?.state.period).toBe('7d');
  });

  it('keeps all views and the overview default for an incomplete org', () => {
    mount('');
    expect(currentView()).toBe('overview');

    navigateBack('?view=feature-adoption');
    expect(currentView()).toBe('feature-adoption');

    navigateBack('?view=ai-usage');
    expect(currentView()).toBe('ai-usage');

    navigateBack('');
    expect(currentView()).toBe('overview');
  });

  it('drops the view param only when it equals the effective default', () => {
    mount('?view=overview', COMPLETE_OPTIONS);
    act(() => {
      latest?.setState({ period: '30d' });
    });
    const params = lastReplacedParams();
    expect(params.get('period')).toBe('30d');
    expect(params.has('view')).toBe(false);
  });

  it('keeps an explicit ai-usage view in the URL for an incomplete org', () => {
    mount('');
    act(() => {
      latest?.setState({ usageView: 'ai-usage' });
    });
    expect(lastReplacedParams().get('view')).toBe('ai-usage');

    act(() => {
      latest?.setState({ usageView: 'overview' });
    });
    expect(lastReplacedParams().has('view')).toBe(false);
  });
});
