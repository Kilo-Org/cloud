/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires -- linkedom and localStorage must exist before the hook module loads. */
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { createRequire } from 'node:module';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { useCollapseToolsPreference as UseCollapseToolsPreference } from './collapse-tools-preference';

type LinkedomParseHtml = (html: string) => { window: typeof globalThis; document: Document };

const requireFromHere = createRequire(__filename);
const { parseHTML } = requireFromHere('linkedom') as { parseHTML: LinkedomParseHtml };
const { window: domWindow, document: domDocument } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);

class StorageEventStub extends domWindow.Event {
  key: string | null;

  constructor(type: string, init?: { key?: string }) {
    super(type);
    this.key = init?.key ?? null;
  }
}

const storage = new Map<string, string>();
const localStorageStub = {
  getItem: (key: string): string | null => storage.get(key) ?? null,
  setItem: (key: string, value: string): void => {
    storage.set(key, String(value));
  },
  removeItem: (key: string): void => {
    storage.delete(key);
  },
  clear: (): void => {
    storage.clear();
  },
};

Object.assign(domWindow, { localStorage: localStorageStub });
Object.assign(globalThis, {
  window: domWindow,
  document: domDocument,
  HTMLElement: domWindow.HTMLElement,
  Element: domWindow.Element,
  Node: domWindow.Node,
  Event: domWindow.Event,
  StorageEvent: StorageEventStub,
  localStorage: localStorageStub,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { useCollapseToolsPreference, COLLAPSE_TOOLS_STORAGE_KEY: KEY } =
  require('./collapse-tools-preference') as {
    useCollapseToolsPreference: typeof UseCollapseToolsPreference;
    COLLAPSE_TOOLS_STORAGE_KEY: string;
  };

type Probe = {
  value: boolean;
  setValue: (value: boolean) => void;
};

let probes: Record<string, Probe> = {};

function CollapseToolsProbe({ slot }: { slot: string }) {
  const { collapseTools, setCollapseTools } = useCollapseToolsPreference();
  probes[slot] = { value: collapseTools, setValue: setCollapseTools };
  return null;
}

describe('useCollapseToolsPreference', () => {
  let root: Root;

  beforeEach(() => {
    localStorageStub.clear();
    probes = {};
    const container = domDocument.getElementById('root');
    if (!container) throw new Error('Missing collapse-tools test root');
    act(() => {
      root = createRoot(container);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  function render(slots: string[]): void {
    act(() => {
      root.render(
        createElement(
          'div',
          null,
          ...slots.map(slot => createElement(CollapseToolsProbe, { key: slot, slot }))
        )
      );
    });
  }

  it('defaults to expanded when this browser has no saved choice', () => {
    render(['transcript']);

    expect(probes.transcript.value).toBe(false);
    expect(localStorageStub.getItem(KEY)).toBeNull();
  });

  it('applies a saved opt-in after mount', () => {
    localStorageStub.setItem(KEY, 'true');

    render(['transcript']);

    expect(probes.transcript.value).toBe(true);
  });

  it('keeps expanded for stored values that are not true', () => {
    for (const raw of ['false', 'TRUE', '{']) {
      localStorageStub.setItem(KEY, raw);
      render(['transcript']);

      expect(probes.transcript.value).toBe(false);

      act(() => root.unmount());
      const container = domDocument.getElementById('root');
      if (!container) throw new Error('Missing collapse-tools test root');
      act(() => {
        root = createRoot(container);
      });
    }
  });

  it('persists a toggle and shares it across transcript consumers', () => {
    render(['one', 'two']);

    act(() => probes.one.setValue(true));

    expect(probes.one.value).toBe(true);
    expect(probes.two.value).toBe(true);
    expect(localStorageStub.getItem(KEY)).toBe('true');

    act(() => probes.two.setValue(false));

    expect(probes.one.value).toBe(false);
    expect(probes.two.value).toBe(false);
    expect(localStorageStub.getItem(KEY)).toBe('false');
  });
});
