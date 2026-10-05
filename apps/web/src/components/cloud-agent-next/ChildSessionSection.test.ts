import React from 'react';
import { createRequire } from 'node:module';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { atom, createStore, Provider } from 'jotai';
import type { KiloSessionId, SessionManager } from '@kilocode/cloud-agent-sdk';
import type { StoredMessage, ToolPart } from './types';
import { useOptionalManager } from './CloudAgentProvider';

jest.mock('./CloudAgentProvider', () => ({ useOptionalManager: jest.fn() }));

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
