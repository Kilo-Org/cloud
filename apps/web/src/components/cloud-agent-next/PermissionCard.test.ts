import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { createRequire } from 'node:module';
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { PermissionCard as PermissionCardComponent } from './PermissionCard';

jest.mock('@/lib/trpc/utils', () => ({
  useRawTRPCClient: () => ({}),
}));

type LinkedomParseHtml = (html: string) => {
  document: Document;
  window: typeof globalThis & {
    Event: typeof Event;
    HTMLElement: typeof HTMLElement;
  };
};

function installLinkedomDom(): {
  cleanup: () => void;
  container: HTMLElement;
} {
  const requireFromHere = createRequire(__filename);
  const requireFromNext = createRequire(requireFromHere.resolve('next/package.json'));
  const { parseHTML } = requireFromNext('linkedom') as { parseHTML: LinkedomParseHtml };
  const { window, document } = parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>'
  );

  const savedGlobals: Record<string, unknown> = {
    React: Reflect.get(globalThis, 'React'),
    window: Reflect.get(globalThis, 'window'),
    document: Reflect.get(globalThis, 'document'),
    HTMLElement: Reflect.get(globalThis, 'HTMLElement'),
    Element: Reflect.get(globalThis, 'Element'),
    Node: Reflect.get(globalThis, 'Node'),
    Event: Reflect.get(globalThis, 'Event'),
    IS_REACT_ACT_ENVIRONMENT: Reflect.get(globalThis, 'IS_REACT_ACT_ENVIRONMENT'),
  };

  Object.assign(globalThis, {
    React,
    window,
    document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  });

  const container = document.getElementById('root');
  if (!container) throw new Error('linkedom root missing');

  return {
    container: container as unknown as HTMLElement,
    cleanup: () => {
      Object.assign(globalThis, savedGlobals);
    },
  };
}

// The card is loaded after the mock registration above: under @swc/jest a
// jest.mock call is not hoisted above the imports, so a static import of the
// card would bind the real tRPC context hook.
let PermissionCard: typeof PermissionCardComponent;

beforeAll(async () => {
  ({ PermissionCard } = await import('./PermissionCard'));
});

describe('PermissionCard display text', () => {
  let domCleanup: (() => void) | undefined;
  let root: Root | undefined;

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = undefined;
    }
    domCleanup?.();
    domCleanup = undefined;
  });

  function renderCard(metadata: Record<string, unknown>, patterns: string[]): HTMLElement {
    const dom = installLinkedomDom();
    domCleanup = dom.cleanup;
    root = createRoot(dom.container);
    act(() => {
      root?.render(
        createElement(PermissionCard, {
          requestId: 'perm_1',
          permission: 'bash',
          patterns,
          metadata,
          always: [],
        })
      );
    });
    return dom.container;
  }

  it('prints each character of the command and pattern as its own spelling', () => {
    const container = renderCard({ command: 'echo A\u202eB\u0000' }, ['/tmp/\u200escope/**']);
    const text = container.textContent ?? '';

    expect(text).toContain('echo A\\u202eB\\x00');
    expect(text).toContain('/tmp/\\u200escope/**');
    expect(text).not.toContain('\u202e');
    expect(text).not.toContain('\u0000');
    expect(text).not.toContain('\u200e');
  });

  it('leaves an ordinary ASCII command unchanged', () => {
    const container = renderCard({ command: 'git status' }, []);
    const text = container.textContent ?? '';

    expect(text).toContain('git status');
    expect(text).not.toContain('\\u');
    expect(text).not.toContain('\\x');
  });
});
