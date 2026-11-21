import { createRequire } from 'node:module';
import React, { act, cloneElement, createContext, createElement, useContext } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AgentBoard } from '@kilocode/session-ingest-contracts';
import type { AgentBoardState } from '@kilocode/cloud-agent-sdk/agent-board';
import { toSafeHttpUrl } from '@/lib/safe-http-url';

type MarkdownProps = {
  children: string;
  urlTransform?: unknown;
  components: {
    a: (props: { href?: string; children?: React.ReactNode }) => React.ReactNode;
    img: (props: { alt?: string }) => React.ReactNode;
  };
};
const mockMarkdownProps: MarkdownProps[] = [];

jest.mock('./CloudAgentProvider', () => ({ useManager: jest.fn() }));
jest.mock('react-markdown', () => ({
  __esModule: true,
  default: (props: MarkdownProps) => {
    mockMarkdownProps.push(props);
    return createElement('p', null, props.children);
  },
}));
jest.mock('remark-gfm', () => ({ __esModule: true, default: () => undefined }));
jest.mock('@/components/ui/sheet', () => {
  const SheetState = createContext({ open: false, onOpenChange: (_open: boolean) => {} });
  const stub =
    (slot: string) =>
    ({ children }: { children?: React.ReactNode }) =>
      createElement('div', { 'data-slot': slot }, children);
  return {
    Sheet: ({
      open,
      onOpenChange,
      children,
    }: {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      children?: React.ReactNode;
    }) => createElement(SheetState.Provider, { value: { open, onOpenChange } }, children),
    SheetTrigger: ({ children }: { children: React.ReactElement<{ onClick?: () => void }> }) => {
      const { open, onOpenChange } = useContext(SheetState);
      return cloneElement(children, { onClick: () => onOpenChange(!open) });
    },
    SheetContent: ({ children }: { children?: React.ReactNode }) =>
      useContext(SheetState).open
        ? createElement('div', { 'data-slot': 'sheet-content' }, children)
        : null,
    SheetHeader: stub('sheet-header'),
    SheetTitle: stub('sheet-title'),
    SheetDescription: stub('sheet-description'),
  };
});

import { AgentBoardDrawer } from './AgentBoardDrawer';

function boardAt(revision: number): AgentBoardState {
  const board: AgentBoard = {
    ownerSessionID: 'ses_root',
    revision,
    messages: [
      {
        id: 'board_1',
        timestamp: 1,
        from: 'ses_child',
        fromLabel: 'Researcher',
        to: 'main',
        type: 'RESULT',
        body: 'Done ![pixel](https://example.invalid/pixel)',
      },
    ],
    hasMore: false,
  };
  return { status: 'current', board };
}

describe('AgentBoardDrawer', () => {
  let root: Root;
  let container: HTMLElement;
  let previous: Map<string, unknown>;
  let EventClass: typeof Event;
  const globals = globalThis as typeof globalThis & Record<string, unknown>;

  beforeEach(() => {
    mockMarkdownProps.length = 0;
    const requireFromHere = createRequire(__filename);
    const requireFromNext = createRequire(requireFromHere.resolve('next/package.json'));
    const { window, document } = (
      requireFromNext('linkedom') as {
        parseHTML: (html: string) => { window: Record<string, unknown>; document: Document };
      }
    ).parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
    EventClass = window.Event as typeof Event;
    const replacements = {
      React,
      window,
      document,
      HTMLElement: window.HTMLElement,
      Element: window.Element,
      Node: window.Node,
      Event: window.Event,
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    previous = new Map(Object.keys(replacements).map(key => [key, globals[key]]));
    Object.assign(globals, replacements);
    const element = document.getElementById('root');
    if (!element) throw new Error('Test root missing');
    container = element;
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    previous.forEach((value, key) => {
      globals[key] = value;
    });
  });

  function render(state: AgentBoardState, onOpenChildSession = jest.fn()) {
    act(() => root.render(createElement(AgentBoardDrawer, { state, onOpenChildSession })));
    return onOpenChildSession;
  }

  function click(element: Element | null | undefined) {
    if (!element) throw new Error('Click target missing');
    act(() => {
      element.dispatchEvent(new EventClass('click', { bubbles: true, cancelable: true }));
    });
  }

  const trigger = () => container.querySelector('button[title="Board"]');

  it('renders nothing for an inactive board', () => {
    render({ status: 'inactive' });
    expect(container.innerHTML).toBe('');
  });

  it('shows the unread dot for a revision newer than the one seen', () => {
    render(boardAt(1));
    expect(trigger()?.getAttribute('aria-label')).toBe('Board, new messages');
    click(trigger());
    expect(trigger()?.getAttribute('aria-label')).toBe('Board');
    click(trigger());
    expect(trigger()?.getAttribute('aria-label')).toBe('Board');
    render(boardAt(2));
    expect(trigger()?.getAttribute('aria-label')).toBe('Board, new messages');
  });

  it('opens the agent transcript and keeps messages that arrived while open as seen', () => {
    const onOpenChildSession = render(boardAt(1));
    click(trigger());
    render(boardAt(2), onOpenChildSession);
    click(container.querySelector('button[title="Open Researcher transcript"]'));
    expect(onOpenChildSession).toHaveBeenCalledWith({
      sessionId: 'ses_child',
      description: 'Researcher',
    });
    expect(container.querySelector('[data-slot="sheet-content"]')).toBeNull();
    expect(trigger()?.getAttribute('aria-label')).toBe('Board');
  });

  it('shows an agent image as its label and keeps an unsafe link as text', () => {
    render(boardAt(1));
    click(trigger());
    const props = mockMarkdownProps.at(-1);
    expect(props?.urlTransform).toBe(toSafeHttpUrl);
    expect(toSafeHttpUrl('javascript:alert(1)')).toBeUndefined();
    act(() =>
      root.render(
        createElement(
          'div',
          null,
          props?.components.img({ alt: 'pixel' }),
          props?.components.a({ href: undefined, children: ' link' })
        )
      )
    );
    expect(container.innerHTML).toBe('<div>pixel link</div>');
  });
});
