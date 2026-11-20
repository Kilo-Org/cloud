/**
 * The parent section, rendered in a linkedom document. This is where the model
 * filter's wiring lives: it narrows the runs list and its failed models, and it
 * must never narrow the registry the Policy tab reads for effort coverage. A
 * test of `BenchmarkConfigEditor` alone cannot catch a regression in that prop.
 *
 * The section is imported after the document is installed (its Radix imports
 * read `document` at module load), which is why this lives in its own file: the
 * static-markup tests in BenchmarksSection.test.ts must not share a document.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import React, { act, createElement } from 'react';
import type { Root } from 'react-dom/client';

// Each query key resolves to the fixture of the same name so the real section
// renders without a client.
const mockQueryFixtures: Record<string, unknown> = {
  'benchmark-registry': {
    engineIdentity: 'v1:abc',
    router: 'efficient',
    repetitions: 3,
    platform: { pending: 0, running: 0, ready: 1, failed: 0 },
    user: { pending: 0, running: 0, ready: 0, failed: 0 },
    platformEntries: [
      { model: 'vendor/ready-at-two-efforts', variant: 'low', status: 'ready' },
      { model: 'vendor/ready-at-two-efforts', variant: 'high', status: 'ready' },
    ],
    failedEntries: [],
  },
  'benchmark-runs': {
    runs: [
      {
        id: 'decider-1',
        router: 'efficient',
        kind: 'decider',
        purpose: 'platform',
        status: 'completed',
        startedAt: '2026-11-20T10:00:00.000Z',
        completedAt: '2026-11-20T10:30:00.000Z',
        error: null,
        models: ['vendor/some-other-model'],
      },
    ],
    hasRunningRun: false,
  },
  'benchmark-routing-table': null,
  'benchmark-scheduler-config': null,
  models: {
    data: [
      {
        id: 'vendor/ready-at-two-efforts',
        name: 'Ready at two efforts',
        opencode: {
          variants: {
            low: { reasoning: { effort: 'low' } },
            high: { reasoning: { effort: 'high' } },
          },
        },
      },
    ],
  },
};

jest.mock('@tanstack/react-query', () => ({
  useQuery: (options: { queryKey?: unknown[] }) => {
    const key = Array.isArray(options.queryKey) ? String(options.queryKey[1] ?? '') : '';
    const data = mockQueryFixtures[key];
    return { data, isLoading: data === undefined, error: null };
  },
  useMutation: () => ({ mutate: () => {}, isPending: false }),
  useQueryClient: () => ({ invalidateQueries: () => {}, setQueryData: () => {} }),
}));

// The catalog is a tRPC data source; the section's own wiring is under test.
jest.mock('@/lib/hooks/use-openrouter-models', () => ({
  useModelSelectorList: () => {
    const data = mockQueryFixtures['models'];
    return { data, isLoading: data === undefined, error: null };
  },
}));

jest.mock('@/components/ui/confirm', () => ({
  useConfirm: () => async () => true,
}));

jest.mock('@/components/shared/ModelCombobox', () => ({ ModelCombobox: () => null }));

// The text input is presentation. Capturing its props lets the test emit the
// same change a keystroke would, without simulating DOM events in linkedom.
const mockModelFilter: { onChange?: (event: { target: { value: string } }) => void } = {};
jest.mock('@/components/ui/input', () => ({
  Input: (props: {
    'aria-label'?: string;
    onChange?: (event: { target: { value: string } }) => void;
  }) => {
    // The card renders many inputs; keep the one this test drives.
    if (props['aria-label'] === 'Find a model by id') mockModelFilter.onChange = props.onChange;
    return createElement('input', { type: 'search' });
  },
}));

// The runs-type picker is a Radix select, which mounts a portal and fragments
// that linkedom cannot host; the filter wiring under test does not touch it.
jest.mock('@/components/ui/select', () => {
  const container = ({ children }: { children?: React.ReactNode }) =>
    createElement('div', null, children);
  return {
    Select: container,
    SelectTrigger: container,
    SelectContent: container,
    SelectItem: container,
    SelectValue: () => null,
  };
});

// Tabs are presentation; keeping every panel mounted lets one render show both
// the runs list and the Policy tab in the same document.
jest.mock('@/components/ui/tabs', () => ({
  Tabs: ({ children }: { children?: React.ReactNode }) => createElement('div', null, children),
  TabsList: ({ children }: { children?: React.ReactNode }) => createElement('div', null, children),
  TabsTrigger: ({ children }: { children?: React.ReactNode }) =>
    createElement('button', { type: 'button' }, children),
  TabsContent: ({ children }: { children?: React.ReactNode }) =>
    createElement('div', null, children),
}));

type LinkedomModule = {
  parseHTML: (html: string) => { window: typeof globalThis; document: Document };
};

function installDom() {
  const requireFromHere = createRequire(__filename);
  const requireFromNext = createRequire(requireFromHere.resolve('next/package.json'));
  const { window, document } = (requireFromNext('linkedom') as LinkedomModule).parseHTML(
    '<html><body><div id="root"></div></body></html>'
  );
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = new Map<string, unknown>();
  for (const name of [
    'window',
    'document',
    'HTMLElement',
    'HTMLInputElement',
    'Element',
    'Node',
    'Event',
    'ResizeObserver',
    'IS_REACT_ACT_ENVIRONMENT',
  ]) {
    previous.set(name, globals[name]);
  }
  class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.assign(globals, {
    window,
    document,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    ResizeObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const container = document.getElementById('root');
  if (!container) throw new Error('Missing test root');
  return {
    container,
    cleanup: () => {
      for (const [name, value] of previous) {
        if (value === undefined) Reflect.deleteProperty(globals, name);
        else globals[name] = value;
      }
    },
  };
}

describe('benchmark section model filter', () => {
  it('narrows the runs list without unmeasuring the Policy tab', async () => {
    const dom = installDom();
    let root: Root | undefined;
    try {
      const [{ createRoot }, section] = await Promise.all([
        import('react-dom/client'),
        import('./BenchmarksSection'),
      ]);
      mockQueryFixtures['benchmark-config'] = {
        config: {
          ...section.formStateToConfig(section.configToFormState(null), null),
          classifierModels: ['classifier'],
          deciderModels: [{ id: 'vendor/ready-at-two-efforts' }],
        },
      };

      root = createRoot(dom.container);
      await act(async () => {
        root?.render(createElement(section.RouterBenchmarksSection, { router: 'efficient' }));
        await Promise.resolve();
      });
      const text = () => dom.container.textContent ?? '';
      // Both panels render: the runs list has its run, the Policy tab its row.
      expect(text()).toContain('vendor/some-other-model');
      expect(text()).toContain('2 of 2 measured');

      const changeModelFilter = mockModelFilter.onChange;
      if (!changeModelFilter) throw new Error('model filter input missing');
      await act(async () => {
        changeModelFilter({ target: { value: 'vendor/nothing-matched' } });
        await Promise.resolve();
      });
      // The filter took effect: its run is gone from the list...
      expect(text()).not.toContain('vendor/some-other-model');
      expect(text()).toContain('No run of this list measured that model');
      // ...and the Policy tab still reads every registry row, so its model stays
      // measured. Passing the filtered entries into the editor breaks this.
      expect(text()).toContain('2 of 2 measured');
      expect(text()).not.toContain('0 of 2 measured');
    } finally {
      if (root) act(() => root?.unmount());
      dom.cleanup();
    }
  });
});
