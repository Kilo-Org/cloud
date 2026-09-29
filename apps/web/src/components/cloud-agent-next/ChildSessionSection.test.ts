import { createRequire } from 'node:module';
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { atom } from 'jotai';
import type { ChildSessionHydrationState, KiloSessionId } from '@kilocode/cloud-agent-sdk';
import type {
  ChildSessionSection as ChildSessionSectionComponent,
  ChildSessionDrawerEntry,
} from './ChildSessionSection';
import type { ChildSessionDrawer as ChildSessionDrawerComponent } from './ChildSessionDrawer';
import type { StoredMessage, ToolPart } from './types';

jest.mock('./CloudAgentProvider', () => ({ useManager: jest.fn() }));
jest.mock('./MessageBubble', () => ({ MessageBubble: () => null }));
jest.mock('./ui/sheet', () => {
  const stub =
    (slot: string) =>
    ({ children }: { children?: React.ReactNode }) =>
      React.createElement('div', { 'data-slot': slot }, children);
  return {
    Sheet: stub('sheet'),
    SheetContent: stub('sheet-content'),
    SheetHeader: stub('sheet-header'),
    SheetTitle: stub('sheet-title'),
    SheetDescription: stub('sheet-description'),
  };
});

function installDom() {
  const requireFromHere = createRequire(__filename);
  const requireFromNext = createRequire(requireFromHere.resolve('next/package.json'));
  const { window, document } = (
    requireFromNext('linkedom') as {
      parseHTML: (html: string) => { window: Record<string, unknown>; document: Document };
    }
  ).parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  const globals = globalThis as typeof globalThis & Record<string, unknown>;
  const values = {
    React,
    window,
    document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    Event: window.Event,
    getComputedStyle: () => ({ animationName: 'none', display: 'block' }),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    cancelAnimationFrame: () => undefined,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(values).map(name => [name, globals[name]]));
  Object.assign(globals, values);
  const container = document.getElementById('root');
  if (!container) throw new Error('ChildSessionSection test root missing');
  return {
    container,
    cleanup: () => previous.forEach((value, name) => (globals[name] = value)),
  };
}

function click(target: Element) {
  act(() => {
    target.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
  });
}

function taskToolPart(metadata: Record<string, unknown>): ToolPart {
  return {
    id: 'task-part',
    sessionID: 'ses-1',
    messageID: 'assistant-1',
    type: 'tool',
    callID: 'call-1',
    tool: 'task',
    state: {
      status: 'completed',
      input: { description: 'Inspect the parser', subagent_type: 'explore' },
      output: 'done',
      title: 'Inspect the parser',
      metadata,
      time: { start: 1, end: 2 },
    },
  };
}

describe('ChildSessionSection drawer entry', () => {
  let ChildSessionSection: typeof ChildSessionSectionComponent;
  let root: Root | undefined;
  let container: HTMLElement;
  let cleanup: () => void;

  beforeAll(async () => {
    const dom = installDom();
    container = dom.container;
    cleanup = dom.cleanup;
    ({ ChildSessionSection } = await import('./ChildSessionSection'));
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
  });

  afterAll(() => {
    cleanup();
  });

  function renderSection(
    metadata: Record<string, unknown>,
    onOpenChildSession: (entry: ChildSessionDrawerEntry) => void
  ) {
    const sessionId = `ses_${'a'.repeat(26)}` as KiloSessionId;
    act(() => {
      root = createRoot(container);
      root.render(
        createElement(ChildSessionSection, {
          taskToolPart: taskToolPart({ sessionId, ...metadata }),
          sessionId,
          onOpenChildSession,
        })
      );
    });
  }

  it.each([
    [
      'with routed model',
      { model: { providerID: 'kilo', modelID: 'anthropic/claude-opus-4.6' } },
      'claude-opus-4.6',
    ],
    ['without model metadata', {}, undefined],
    ['with malformed model metadata', { model: { providerID: 'kilo' } }, undefined],
    ['with empty model fields', { model: { providerID: '', modelID: '' } }, undefined],
  ])('builds the drawer entry %s', (_name, metadata, expectedModel) => {
    const onOpenChildSession = jest.fn();
    renderSection(metadata, onOpenChildSession);
    const trigger = container.querySelector('button');
    if (!trigger) throw new Error('child session trigger missing');
    click(trigger);

    expect(onOpenChildSession).toHaveBeenCalledWith({
      sessionId: `ses_${'a'.repeat(26)}`,
      description: 'Inspect the parser',
      agent: 'explore',
      model: expectedModel,
    });
  });
});

describe('ChildSessionDrawer header', () => {
  let ChildSessionDrawer: typeof ChildSessionDrawerComponent;
  let root: Root | undefined;
  let container: HTMLElement;
  let cleanup: () => void;
  const manager = {
    atoms: {
      childMessages: atom(() => (_sessionId: string): StoredMessage[] => []),
      childSessionHydrationState: atom(
        () =>
          (_sessionId: string): ChildSessionHydrationState => ({
            status: 'ready',
            cursor: null,
            hasOlder: false,
            isLoadingOlder: false,
            olderError: null,
            omittedItemCount: 0,
          })
      ),
    },
    hydrateChildSession: jest.fn(),
    loadOlderChildMessages: jest.fn(),
  };

  beforeAll(async () => {
    const dom = installDom();
    container = dom.container;
    cleanup = dom.cleanup;
    const provider = await import('./CloudAgentProvider');
    (provider.useManager as unknown as jest.Mock).mockReturnValue(manager);
    ({ ChildSessionDrawer } = await import('./ChildSessionDrawer'));
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
  });

  afterAll(() => {
    cleanup();
  });

  function renderDrawer(entry: ChildSessionDrawerEntry) {
    act(() => {
      root = createRoot(container);
      root.render(
        createElement(ChildSessionDrawer, {
          stack: [entry],
          onBack: () => undefined,
          onOpenChange: () => undefined,
          onOpenChildSession: () => undefined,
        })
      );
    });
  }

  it('shows the routed model next to the agent', () => {
    renderDrawer({
      sessionId: `ses_${'b'.repeat(26)}` as KiloSessionId,
      description: 'Inspect the parser',
      agent: 'explore',
      model: 'claude-opus-4.6',
    });

    expect(container.innerHTML).toContain('Agent: explore');
    expect(container.innerHTML).toContain('Model: claude-opus-4.6');
  });

  it('omits the model row when the entry has none', () => {
    renderDrawer({
      sessionId: `ses_${'c'.repeat(26)}` as KiloSessionId,
      description: 'Inspect the parser',
      agent: 'explore',
    });

    expect(container.innerHTML).toContain('Agent: explore');
    expect(container.innerHTML).not.toContain('Model:');
  });
});
