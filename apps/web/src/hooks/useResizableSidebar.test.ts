/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires -- linkedom and localStorage must exist before the hook module loads. */
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { createRequire } from 'node:module';
import { act, createElement, type MouseEvent as ReactMouseEvent } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { useResizableSidebar as UseResizableSidebar } from './useResizableSidebar';

type LinkedomParseHtml = (html: string) => { window: typeof globalThis; document: Document };

const requireFromHere = createRequire(__filename);
const { parseHTML } = requireFromHere('linkedom') as { parseHTML: LinkedomParseHtml };
const { window: domWindow, document: domDocument } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);

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
  localStorage: localStorageStub,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { useResizableSidebar } = require('./useResizableSidebar') as {
  useResizableSidebar: typeof UseResizableSidebar;
};

const KEY = 'cloud-agent:worktree-changes-list-width';
const INITIAL = 448;
const MIN = 200;
const MAX = 640;

let widths: number[] = [];
let controls: { width: number; startDrag: (event: ReactMouseEvent) => void } | undefined;

function WidthProbe({ storageKey }: { storageKey?: string }) {
  const { width, startDrag } = useResizableSidebar(INITIAL, MIN, MAX, storageKey);
  widths.push(width);
  controls = { width, startDrag };
  return null;
}

function dispatchMouse(type: string, clientX: number): void {
  const event = new domWindow.Event(type, { bubbles: true });
  Object.defineProperty(event, 'clientX', { value: clientX });
  domDocument.dispatchEvent(event);
}

describe('useResizableSidebar', () => {
  let root: Root;

  beforeEach(() => {
    localStorageStub.clear();
    widths = [];
    controls = undefined;
    const container = domDocument.getElementById('root');
    if (!container) throw new Error('Missing useResizableSidebar test root');
    act(() => {
      root = createRoot(container);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  function render(storageKey?: string): void {
    act(() => {
      root.render(createElement(WidthProbe, { storageKey }));
    });
  }

  it('restores the stored width, starting the first render at the initial width', () => {
    localStorageStub.setItem(KEY, '540');

    render(KEY);

    expect(widths[0]).toBe(INITIAL);
    expect(controls?.width).toBe(540);
  });

  it('keeps the initial width when no stored value exists', () => {
    render(KEY);

    expect(widths[0]).toBe(INITIAL);
    expect(controls?.width).toBe(INITIAL);
  });

  it('keeps the initial width for a blank stored value', () => {
    localStorageStub.setItem(KEY, '   ');

    render(KEY);

    expect(widths[0]).toBe(INITIAL);
    expect(controls?.width).toBe(INITIAL);
  });

  it('keeps the initial width for a non-numeric stored value', () => {
    localStorageStub.setItem(KEY, 'abc');

    render(KEY);

    expect(widths[0]).toBe(INITIAL);
    expect(controls?.width).toBe(INITIAL);
  });

  it('clamps a stored width above the maximum', () => {
    localStorageStub.setItem(KEY, '9000');

    render(KEY);

    expect(controls?.width).toBe(MAX);
  });

  it('persists the dragged width on mouseup without writing on mousemove or clobbering it on restore', () => {
    localStorageStub.setItem(KEY, '540');
    render(KEY);
    expect(controls?.width).toBe(540);

    act(() => {
      controls!.startDrag({ clientX: 200 } as unknown as ReactMouseEvent);
    });
    act(() => {
      dispatchMouse('mousemove', 260);
    });

    expect(controls?.width).toBe(600);
    expect(localStorageStub.getItem(KEY)).toBe('540');

    act(() => {
      dispatchMouse('mouseup', 260);
    });

    expect(localStorageStub.getItem(KEY)).toBe('600');
  });

  it('does not read or write storage when the key is omitted', () => {
    localStorageStub.setItem(KEY, '540');

    render();

    expect(controls?.width).toBe(INITIAL);

    act(() => {
      controls!.startDrag({ clientX: 200 } as unknown as ReactMouseEvent);
    });
    act(() => {
      dispatchMouse('mousemove', 250);
    });
    act(() => {
      dispatchMouse('mouseup', 250);
    });

    expect(localStorageStub.getItem(KEY)).toBe('540');
  });
});
