import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { WorktreeFileRecord } from '@kilocode/worker-utils/cloud-agent-worktree-changes';
import type { WorktreeDiffStyle } from './WorktreeFileRenderer';

type LinkedomModule = {
  parseHTML: (html: string) => { window: Record<string, unknown>; document: Document };
};

const require = createRequire(import.meta.url);
const requireFromNext = createRequire(require.resolve('next/package.json'));
const { window, document } = (requireFromNext('linkedom') as LinkedomModule).parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);

const LinkedomEvent = (window as unknown as { Event: new (type: string) => Event }).Event;

class StorageEventStub extends LinkedomEvent {
  key: string | null;
  constructor(type: string, init?: { key?: string }) {
    super(type);
    this.key = init?.key ?? null;
  }
}

const storage = new Map<string, string>();
const localStorageStub = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storage.set(key, String(value));
  },
  removeItem: (key: string) => {
    storage.delete(key);
  },
};
const typedWindow = window as Record<string, unknown>;
typedWindow.localStorage = localStorageStub;

const globals = globalThis as typeof globalThis & Record<string, unknown>;
for (const [name, value] of Object.entries({
  window: typedWindow,
  document,
  HTMLElement: (window as { HTMLElement: unknown }).HTMLElement,
  Element: (window as { Element: unknown }).Element,
  Node: (window as { Node: unknown }).Node,
  Event: (window as { Event: unknown }).Event,
  StorageEvent: StorageEventStub,
  localStorage: localStorageStub,
  customElements: {
    get: () => undefined,
    define: () => {},
  },
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  globals[name] = value;
}

const warnings: unknown[][] = [];
console.warn = (...args: unknown[]) => {
  warnings.push(args);
};

const {
  useLocalStorage,
}: typeof import('../../hooks/useLocalStorage/useLocalStorage') = require('../../hooks/useLocalStorage/useLocalStorage');
const {
  default: WorktreeFileRenderer,
  parseWorktreeDiffStyle,
}: typeof import('./WorktreeFileRenderer') = require('./WorktreeFileRenderer');

const KEY = 'cloud-agent:worktree-diff-style';

const patch = `diff --git a/src/example.ts b/src/example.ts
index 1234567..abcdef0 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,3 +1,3 @@
 first
-old value
+new value
 last
`;
const file: WorktreeFileRecord = {
  schemaVersion: 1,
  revision: 3,
  path: 'src/example.ts',
  diff: { status: 'available', patch },
  content: { status: 'available', source: 'current', text: 'first\nnew value\nlast\n' },
};

function mount(render: () => ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(render()));
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function probeValues(container: HTMLElement) {
  return Array.from(container.querySelectorAll('[data-probe]')).map(node => ({
    slot: node.getAttribute('data-probe'),
    value: node.textContent,
  }));
}

describe('worktree diff style storage', () => {
  it('shares one split preference across consumers and reads it back on remount', () => {
    const setValue = { current: (_value: WorktreeDiffStyle) => {} };
    const mounted = mount(() => {
      function ProbeSource() {
        const [value, setStored] = useLocalStorage<WorktreeDiffStyle>(KEY, 'unified', {
          initializeWithValue: false,
          deserializer: parseWorktreeDiffStyle,
        });
        setValue.current = setStored as (value: WorktreeDiffStyle) => void;
        return createElement('span', { 'data-probe': 'source' }, value);
      }
      function ProbeSink() {
        const [value] = useLocalStorage<WorktreeDiffStyle>(KEY, 'unified', {
          initializeWithValue: false,
          deserializer: parseWorktreeDiffStyle,
        });
        return createElement('span', { 'data-probe': 'sink' }, value);
      }
      return createElement('div', null, createElement(ProbeSource), createElement(ProbeSink));
    });
    assert.deepEqual(probeValues(mounted.container), [
      { slot: 'source', value: 'unified' },
      { slot: 'sink', value: 'unified' },
    ]);
    act(() => setValue.current('split'));
    assert.deepEqual(probeValues(mounted.container), [
      { slot: 'source', value: 'split' },
      { slot: 'sink', value: 'split' },
    ]);
    assert.equal(storage.get(KEY), JSON.stringify('split'));
    mounted.unmount();

    const readBack = mount(() => {
      function Probe() {
        const [value] = useLocalStorage<WorktreeDiffStyle>(KEY, 'unified', {
          initializeWithValue: false,
          deserializer: parseWorktreeDiffStyle,
        });
        return createElement('span', { 'data-probe': 'read' }, value);
      }
      return createElement(Probe);
    });
    assert.deepEqual(probeValues(readBack.container), [{ slot: 'read', value: 'split' }]);
    readBack.unmount();
    assert.deepEqual(warnings, []);
  });

  it('applies the stored split preference and toggles it without changing the view mode', () => {
    storage.set(KEY, JSON.stringify('split'));
    const modeChanges: string[] = [];
    const mounted = mount(() =>
      createElement(WorktreeFileRenderer, {
        file,
        mode: 'diff',
        onModeChange: (mode: string) => modeChanges.push(mode),
      })
    );
    const toggle = () =>
      mounted.container.querySelector(
        'button[aria-label="Show unified diff"], button[aria-label="Show side-by-side diff"]'
      );
    assert.equal(toggle()?.getAttribute('aria-label'), 'Show unified diff');
    assert.equal(toggle()?.getAttribute('aria-pressed'), 'true');
    act(() => (toggle() as HTMLElement | null)?.click());
    assert.equal(toggle()?.getAttribute('aria-label'), 'Show side-by-side diff');
    assert.equal(toggle()?.getAttribute('aria-pressed'), 'false');
    assert.equal(storage.get(KEY), JSON.stringify('unified'));
    assert.deepEqual(modeChanges, []);
    mounted.unmount();
    assert.deepEqual(warnings, []);
  });

  it('resolves malformed stored values to unified through the production deserializer', () => {
    for (const raw of ['split', '{']) {
      storage.set(KEY, raw);
      const mounted = mount(() => {
        function Probe() {
          const [value] = useLocalStorage<WorktreeDiffStyle>(KEY, 'unified', {
            initializeWithValue: false,
            deserializer: parseWorktreeDiffStyle,
          });
          return createElement('span', { 'data-probe': 'malformed' }, value);
        }
        return createElement(Probe);
      });
      assert.deepEqual(
        probeValues(mounted.container),
        [{ slot: 'malformed', value: 'unified' }],
        raw
      );
      mounted.unmount();
    }
    assert.deepEqual(warnings, []);
  });
});
