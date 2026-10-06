import { createRequire } from 'node:module';
import React, { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { atom, createStore, Provider } from 'jotai';
import type {
  ChildSessionHydrationState,
  KiloSessionId,
  SessionManager,
} from '@kilocode/cloud-agent-sdk';
import type { ChildSessionDrawerEntry } from './ChildSessionSection';
import type { ChildSessionDrawer as ChildSessionDrawerComponent } from './ChildSessionDrawer';
import type { StoredMessage, ToolPart } from './types';

jest.mock('./CloudAgentProvider', () => ({
  useManager: jest.fn(),
  useOptionalManager: jest.fn(),
}));
jest.mock('./MessageBubble', () => ({ MessageBubble: () => null }));
jest.mock('@/components/ui/sheet', () => {
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

import { useOptionalManager } from './CloudAgentProvider';
import { ChildSessionSection } from './ChildSessionSection';

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

const childSessionId = `ses_${'a'.repeat(26)}` as KiloSessionId;

function readToolPart(id: string): ToolPart {
  return {
    id,
    sessionID: childSessionId,
    messageID: 'child-1',
    type: 'tool',
    callID: id,
    tool: 'read',
    state: {
      status: 'completed',
      input: { filePath: '/repo/file.ts' },
      output: 'content',
      title: 'Read',
      metadata: {},
      time: { start: 1, end: 2 },
    },
  };
}

function childMessageWithTools(count: number): StoredMessage {
  return {
    info: {
      id: 'child-1',
      sessionID: childSessionId,
      role: 'assistant',
      time: { created: 1, completed: 2 },
      parentID: 'parent-1',
      modelID: 'test-model',
      providerID: 'test-provider',
      mode: 'code',
      agent: 'test-agent',
      path: { cwd: '/', root: '/' },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: Array.from({ length: count }, (_, index) => readToolPart(`tool-${index}`)),
  };
}

const parentPart: ToolPart = {
  id: 'task-1',
  sessionID: 'ses-root',
  messageID: 'parent-1',
  type: 'tool',
  callID: 'task-1',
  tool: 'task',
  state: {
    status: 'running',
    input: { description: 'Explore repo', subagent_type: 'explore' },
    metadata: { sessionId: childSessionId },
    time: { start: 1 },
  },
};

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

describe('ChildSessionSection live subscription', () => {
  let root: Root | undefined;
  let container: HTMLElement;
  let cleanup: () => void;

  beforeAll(() => {
    const dom = installDom();
    container = dom.container;
    cleanup = dom.cleanup;
  });

  afterAll(() => cleanup());

  beforeEach(() => {
    container.textContent = '';
    jest.mocked(useOptionalManager).mockReturnValue(null);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = undefined;
  });

  it('updates the child tool count from the manager atom without new props', () => {
    const store = createStore();
    const sourceAtom = atom<{ getter: (sessionId: string) => StoredMessage[] }>({
      getter: () => [],
    });
    const childMessagesAtom = atom(get => get(sourceAtom).getter);
    jest.mocked(useOptionalManager).mockReturnValue({
      atoms: { childMessages: childMessagesAtom },
    } as unknown as SessionManager);

    act(() => {
      root?.render(
        createElement(
          Provider,
          { store },
          createElement(ChildSessionSection, {
            taskToolPart: parentPart,
            sessionId: childSessionId,
          })
        )
      );
    });
    expect(container.textContent).not.toContain('tool call');

    act(() => {
      store.set(sourceAtom, { getter: () => [childMessageWithTools(2)] });
    });
    expect(container.textContent).toContain('2 tool calls');
  });

  it('falls back to the childMessages prop when the manager has no childMessages atom', () => {
    jest.mocked(useOptionalManager).mockReturnValue({ atoms: {} } as unknown as SessionManager);

    act(() => {
      root?.render(
        createElement(ChildSessionSection, {
          taskToolPart: parentPart,
          sessionId: childSessionId,
          childMessages: [childMessageWithTools(3)],
        })
      );
    });
    expect(container.textContent).toContain('3 tool calls');
  });

  it('falls back to the childMessages prop when no manager is present', () => {
    act(() => {
      root?.render(
        createElement(ChildSessionSection, {
          taskToolPart: parentPart,
          sessionId: childSessionId,
          childMessages: [childMessageWithTools(1)],
        })
      );
    });
    expect(container.textContent).toContain('1 tool call');
  });
});

describe('ChildSessionSection drawer entry', () => {
  let root: Root | undefined;
  let container: HTMLElement;
  let cleanup: () => void;

  beforeAll(() => {
    const dom = installDom();
    container = dom.container;
    cleanup = dom.cleanup;
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
