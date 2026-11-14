import React, { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createRequire } from 'node:module';
import type { StoredSession } from './types';
import type { WorkspaceFolder } from '@/lib/cloud-agent/workspace-folders';

Object.assign(globalThis, { React });

let mockPathname = '/cloud';
let mockStackedSource: {
  source?: { branch: string; repository: string; basePushed: boolean };
  isPending: boolean;
} = { source: undefined, isPending: false };
const mockRouterPush = jest.fn();
const mockRouter = { push: mockRouterPush };

jest.mock('./hooks/useStackedWorkspaceSource', () => ({
  useStackedWorkspaceSource: () => mockStackedSource,
}));

jest.mock('next/navigation', () => ({
  useRouter: () => mockRouter,
  usePathname: () => mockPathname,
}));

jest.mock('@/components/shared/TimeAgo', () => ({
  TimeAgo: () =>
    jest
      .requireActual<typeof React>('react')
      .createElement('time', { 'data-time-ago': true }, 'time'),
}));

jest.mock('@/components/ui/tooltip', () => {
  const react = jest.requireActual<typeof React>('react');
  const passthrough = ({ children }: { children?: ReactNode }) =>
    react.createElement(react.Fragment, null, children);
  return {
    Tooltip: jest.fn(passthrough),
    TooltipTrigger: passthrough,
    TooltipContent: ({
      children,
      className,
      side,
      align,
      sideOffset,
    }: {
      children?: ReactNode;
      className?: string;
      side?: string;
      align?: string;
      sideOffset?: number;
    }) =>
      react.createElement(
        'div',
        {
          role: 'tooltip',
          className,
          'data-side': side,
          'data-align': align,
          'data-offset': sideOffset,
        },
        children
      ),
    TooltipProvider: passthrough,
  };
});

jest.mock('@/components/ui/dropdown-menu', () => {
  const react = jest.requireActual<typeof React>('react');
  const passthrough = ({ children }: { children?: ReactNode }) =>
    react.createElement(react.Fragment, null, children);
  return {
    DropdownMenu: passthrough,
    DropdownMenuTrigger: passthrough,
    DropdownMenuContent: passthrough,
    DropdownMenuItem: ({
      children,
      onClick,
      onSelect,
      disabled,
    }: {
      children?: ReactNode;
      onClick?: (event: React.MouseEvent) => void;
      onSelect?: () => void;
      disabled?: boolean;
    }) =>
      react.createElement(
        'div',
        {
          role: 'menuitem',
          'aria-disabled': disabled || undefined,
          onClick: (event: React.MouseEvent) => {
            if (disabled) return;
            onClick?.(event);
            onSelect?.();
          },
        },
        children
      ),
    DropdownMenuLabel: passthrough,
    DropdownMenuSeparator: () => null,
    DropdownMenuCheckboxItem: passthrough,
    DropdownMenuRadioGroup: passthrough,
    DropdownMenuRadioItem: ({ children }: { children?: ReactNode }) =>
      react.createElement('div', { role: 'menuitemradio' }, children),
    DropdownMenuSub: passthrough,
    DropdownMenuSubTrigger: passthrough,
    DropdownMenuSubContent: passthrough,
    DropdownMenuPortal: passthrough,
    DropdownMenuGroup: passthrough,
    DropdownMenuShortcut: passthrough,
  };
});

jest.mock('@/components/ui/alert-dialog', () => {
  const react = jest.requireActual<typeof React>('react');
  const Context = react.createContext({ open: false, onOpenChange: (_open: boolean) => {} });
  const passthrough = ({ children }: { children?: ReactNode }) =>
    react.createElement(react.Fragment, null, children);
  return {
    AlertDialog: ({
      open,
      onOpenChange,
      children,
    }: {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      children?: ReactNode;
    }) => react.createElement(Context.Provider, { value: { open, onOpenChange } }, children),
    AlertDialogContent: ({ children }: { children?: ReactNode }) =>
      react.useContext(Context).open
        ? react.createElement('div', { role: 'dialog' }, children)
        : null,
    AlertDialogHeader: passthrough,
    AlertDialogTitle: passthrough,
    AlertDialogDescription: passthrough,
    AlertDialogFooter: passthrough,
    AlertDialogCancel: ({ children }: { children?: ReactNode }) => {
      const { onOpenChange } = react.useContext(Context);
      return react.createElement('button', { onClick: () => onOpenChange(false) }, children);
    },
    AlertDialogAction: ({
      children,
      onClick,
      disabled,
    }: {
      children?: ReactNode;
      onClick: () => void;
      disabled?: boolean;
    }) => react.createElement('button', { onClick, disabled }, children),
  };
});

jest.mock('./SessionPrIndicator', () => ({
  SessionPrIndicator: jest.fn(({ session }: { session: StoredSession }) =>
    jest.requireActual<typeof React>('react').createElement('span', {
      'data-session-pr': session.sessionId,
    })
  ),
}));

import { ChatSidebar } from './ChatSidebar';
import { SessionPrIndicator } from './SessionPrIndicator';
import { Tooltip } from '@/components/ui/tooltip';
import { getDefaultStore } from 'jotai';
import { stackedWorkspaceTargetAtom } from './store/stacked-workspace-atoms';

type ChatSidebarProps = React.ComponentProps<typeof ChatSidebar>;

const SESSION_COUNT = 200;
const indicatorMock = jest.mocked(SessionPrIndicator);
const tooltipMock = jest.mocked(Tooltip);

jest.setTimeout(30_000);

function installDom() {
  const requireFromHere = createRequire(__filename);
  const requireFromNext = createRequire(requireFromHere.resolve('next/package.json'));
  const { window, document } = (
    requireFromNext('linkedom') as {
      parseHTML: (html: string) => { window: Window & typeof globalThis; document: Document };
    }
  ).parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');

  document.oninput = null;

  const values = {
    React,
    window,
    document,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    Element: window.Element,
    Node: window.Node,
    Text: window.Text,
    Comment: window.Comment,
    DocumentFragment: window.DocumentFragment,
    Document: window.Document,
    SVGElement: window.SVGElement,
    CustomEvent: window.CustomEvent,
    navigator: window.navigator,
    Event: window.Event,
    getComputedStyle: () => ({ animationName: 'none', display: 'block' }),
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    cancelAnimationFrame: () => undefined,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    Object.keys(values).map(name => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name) as PropertyDescriptor | undefined,
    ])
  );
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  Object.assign(window.HTMLElement.prototype, {
    scrollIntoView: () => undefined,
    select: () => undefined,
  });

  const container = document.getElementById('root');
  if (!container) throw new Error('ChatSidebar test root missing');
  return {
    container: container as HTMLElement,
    cleanup: () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

function makeSession(index: number, overrides: Partial<StoredSession> = {}): StoredSession {
  const suffix = index.toString().padStart(3, '0');
  return {
    sessionId: `ses_${suffix}`,
    repository: 'kilo/repository',
    prompt: `Prompt ${suffix}`,
    mode: 'code',
    model: 'test-model',
    status: 'completed',
    createdAt: new Date(Date.now() - index * 10_000).toISOString(),
    updatedAt: new Date(Date.now() - index * 1_000).toISOString(),
    messages: [],
    sessionStatus: null,
    associatedPr: null,
    ...overrides,
  };
}

function makeSessions(count: number): StoredSession[] {
  return Array.from({ length: count }, (_, index) => makeSession(index));
}

function replaceSession(
  sessions: StoredSession[],
  index: number,
  overrides: Partial<StoredSession>
): StoredSession[] {
  return sessions.map((session, i) => (i === index ? { ...session, ...overrides } : session));
}

function activeSession(
  session: StoredSession,
  status = 'idle',
  organizationId: string | null = null
) {
  return {
    id: session.sessionId,
    status,
    title: session.prompt,
    connectionId: 'test-connection',
    // The router attributes every row it returns; `null` is the personal
    // scope, and the sidebar filters live rows by it.
    organizationId,
  };
}

function baseProps(overrides: Partial<ChatSidebarProps> = {}): ChatSidebarProps {
  return { sessions: [], ...overrides };
}

describe('ChatSidebar row rendering', () => {
  let dom: ReturnType<typeof installDom>;
  let root: Root;

  beforeAll(() => {
    dom = installDom();
  });

  afterAll(() => dom.cleanup());

  beforeEach(() => {
    mockPathname = '/cloud';
    mockStackedSource = { source: undefined, isPending: false };
    mockRouterPush.mockClear();
    indicatorMock.mockClear();
    tooltipMock.mockClear();
    root = createRoot(dom.container);
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  function renderSidebar(overrides: Partial<ChatSidebarProps> = {}): void {
    const props = baseProps(overrides);
    act(() => {
      root.render(React.createElement(ChatSidebar, props));
    });
  }

  it('does not flash an empty state while the session list loads', () => {
    renderSidebar({ isLoading: true });
    expect(dom.container.querySelector('[role="status"]')?.getAttribute('aria-label')).toBe(
      'Loading sessions'
    );
    expect(dom.container.textContent).not.toContain('No sessions yet');
    renderSidebar({ isLoading: false });
    expect(dom.container.textContent).toContain('No sessions yet');
  });

  it('rerenders only the two affected workspace rows when selection changes', () => {
    const sessions = makeSessions(SESSION_COUNT).map((session, index) => ({
      ...session,
      worktreeId: `worktree_${index}`,
    }));
    const onOpenSession = jest.fn();
    renderSidebar({ sessions, currentSessionId: sessions[0].sessionId, onOpenSession });
    tooltipMock.mockClear();
    renderSidebar({ sessions, currentSessionId: sessions[1].sessionId, onOpenSession });
    expect(tooltipMock.mock.calls.filter(([props]) => props.delayDuration === 400)).toHaveLength(2);
  });

  it('uses updated workspace actions even when the row does not rerender', () => {
    const session = makeSession(0, { worktreeId: 'worktree_actions' });
    const sessions = [session];
    const previous = jest.fn();
    const next = jest.fn();
    renderSidebar({ sessions, onOpenSession: previous });
    tooltipMock.mockClear();
    renderSidebar({ sessions, onOpenSession: next });
    expect(tooltipMock.mock.calls.filter(([props]) => props.delayDuration === 400)).toHaveLength(0);
    const button = dom.container.querySelector<HTMLButtonElement>('[data-worktree-id] button');
    act(() => button?.click());
    expect(previous).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(session.sessionId);
  });

  it('keeps one skeleton until sessions, names and folders are ready together', () => {
    const session = makeSession(0, { worktreeId: 'worktree_ready' });
    renderSidebar({ sessions: [session], isLoading: true });
    expect(dom.container.querySelector('[aria-label="Loading sessions"]')).not.toBeNull();
    expect(dom.container.querySelector('[data-worktree-id="worktree_ready"]')).toBeNull();

    renderSidebar({ sessions: [session] });
    expect(dom.container.querySelector('[aria-label="Loading sessions"]')).toBeNull();
    expect(dom.container.querySelector('[data-worktree-id="worktree_ready"]')).not.toBeNull();
  });

  it('passes the displayed worktree name to the current delete action without rerendering', () => {
    const sessions = [makeSession(0, { worktreeId: 'worktree_delete' })];
    const worktreeDetails = {
      worktree_delete: {
        name: 'Named workspace',
        defaultTitle: null,
        prSession: null,
        sessions: [],
      },
    };
    const previous = jest.fn();
    const next = jest.fn();
    renderSidebar({ sessions, worktreeDetails, onDeleteWorktree: previous });
    tooltipMock.mockClear();
    renderSidebar({ sessions, worktreeDetails, onDeleteWorktree: next });
    expect(tooltipMock.mock.calls.filter(([props]) => props.delayDuration === 400)).toHaveLength(0);
    const deleteItem = Array.from(
      dom.container.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ).find(item => item.textContent === 'Delete worktree');
    expect(deleteItem).toBeDefined();
    act(() => deleteItem?.click());
    expect(previous).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith('worktree_delete', 'Named workspace');
  });

  it('shows the full workspace title above the row, away from the sibling PR badge', () => {
    const session = makeSession(0, {
      worktreeId: 'worktree_tooltip',
      associatedPr: {
        url: 'https://github.com/kilo/repository/pull/42',
        number: 42,
        state: 'open',
        title: 'Fix sidebar tooltips',
        headSha: null,
        lastSyncedAt: new Date().toISOString(),
        reviewDecision: null,
        reviewDecisionPending: false,
        platform: 'github',
        observations: null,
      },
    });
    const title = 'Cloud Agent sidebar session titles should remain readable when truncated';
    const onOpenSession = jest.fn();
    renderSidebar({
      sessions: [session],
      onOpenSession,
      worktreeDetails: {
        worktree_tooltip: { name: title, defaultTitle: null, prSession: session, sessions: [] },
      },
    });

    const row = dom.container.querySelector('[data-worktree-id="worktree_tooltip"]');
    const tooltip = row?.querySelector('[role="tooltip"]');
    expect(tooltipMock.mock.calls.map(([props]) => props.delayDuration)).toContain(400);
    expect(tooltip?.textContent).toBe(title);
    expect(tooltip?.className).toContain('max-w-xs');
    expect(tooltip?.className).toContain('break-words');
    expect(tooltip?.getAttribute('data-side')).toBe('top');
    expect(tooltip?.getAttribute('data-align')).toBe('start');
    expect(tooltip?.getAttribute('data-offset')).toBe('8');

    const button = row?.querySelector<HTMLButtonElement>(
      `button[aria-label="Open worktree ${title}"]`
    );
    expect(button?.querySelector('.line-clamp-1')?.textContent).toBe(title);
    expect(row?.querySelector('[data-session-pr="ses_000"]')).not.toBeNull();
    expect(button?.querySelector('[data-session-pr]')).toBeNull();
    act(() => button?.click());
    expect(onOpenSession).toHaveBeenCalledWith(session.sessionId);

    renderSidebar({ sessions: [session] });
    expect(row?.querySelector('[role="tooltip"]')?.textContent).toBe(session.repository);
  });

  it('lets the owner choose which chat a worktree opens, newest first', () => {
    const older = makeSession(2, { worktreeId: 'worktree_choice' });
    const newer = makeSession(1, { worktreeId: 'worktree_choice' });
    const onOpenSession = jest.fn();
    const onOpenWorktree = jest.fn();
    const onMobileSheetOpenChange = jest.fn();
    renderSidebar({
      sessions: [older, newer],
      onOpenSession,
      onOpenWorktree,
      onMobileSheetOpenChange,
    });

    act(() =>
      dom.container
        .querySelector<HTMLButtonElement>(
          '[data-worktree-id="worktree_choice"] button[aria-label^="Open worktree"]'
        )
        ?.click()
    );

    expect(onOpenWorktree).toHaveBeenCalledWith('worktree_choice', [
      newer.sessionId,
      older.sessionId,
    ]);
    expect(onOpenSession).not.toHaveBeenCalled();
    expect(onMobileSheetOpenChange).toHaveBeenCalledWith(false);
  });

  it('waits for the worktree name instead of flashing a repository label', () => {
    const session = makeSession(0, { worktreeId: 'worktree_loading' });
    renderSidebar({ sessions: [session], loadingWorktreeIds: ['worktree_loading'] });
    const row = dom.container.querySelector('[data-worktree-id="worktree_loading"]');
    expect(row?.querySelector('[role="tooltip"][data-side="top"]')).toBeNull();
    expect(row?.textContent).not.toContain(session.repository);
    expect(
      row?.querySelector('button[aria-label="Open worktree Loading worktree…"]')
    ).not.toBeNull();
    renderSidebar({
      sessions: [session],
      worktreeDetails: {
        worktree_loading: {
          name: 'Stable workspace title',
          defaultTitle: null,
          prSession: null,
          sessions: [],
        },
      },
    });
    expect(
      dom.container.querySelector('[data-worktree-id="worktree_loading"]')?.textContent
    ).toContain('Stable workspace title');
    // A metadata failure must leave the row usable with its repository fallback.
    renderSidebar({ sessions: [session] });
    expect(
      dom.container.querySelector('[data-worktree-id="worktree_loading"]')?.textContent
    ).toContain(session.repository);
  });

  it.each([
    ['failed', 'Last run failed'],
    ['system_interrupted', 'Last run stopped unexpectedly'],
  ] as const)(
    'renders an accessible standalone %s warning instead of its timestamp',
    (latestRunFailureKind, label) => {
      const session = makeSession(0, { sessionStatus: 'idle', latestRunFailureKind });
      renderSidebar({ sessions: [session], activeSessions: [activeSession(session)] });

      const row = rowElement(session.sessionId);
      const warning = row.querySelector(`[role="img"][aria-label="${label}"]`);
      expect(warning).not.toBeNull();
      expect(warning?.getAttribute('title')).toBe(label);
      expect(warning?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
      expect(row.querySelector('[data-time-ago]')).toBeNull();
    }
  );

  it.each(['busy', 'retry', 'question', 'permission'])(
    'renders standalone %s activity instead of the previous failure',
    sessionStatus => {
      const session = makeSession(0, { sessionStatus, latestRunFailureKind: 'failed' });
      renderSidebar({ sessions: [session] });

      const row = rowElement(session.sessionId);
      expect(row.querySelector('[aria-label="Last run failed"]')).toBeNull();
      expect(row.querySelector('[data-time-ago]')).toBeNull();
      if (sessionStatus === 'busy' || sessionStatus === 'retry') {
        expect(row.innerHTML).toContain(
          sessionStatus === 'busy' ? '<title>Busy</title>' : '<title>Retrying</title>'
        );
      } else {
        const label =
          sessionStatus === 'question' ? 'Waiting for answer' : 'Waiting for permission';
        expect(row.querySelector(`[aria-label="${label}"]`)).not.toBeNull();
      }
    }
  );

  it('clears the standalone warning on a new run and restores the timestamp after success', () => {
    const session = makeSession(0, { sessionStatus: 'idle', latestRunFailureKind: 'failed' });
    renderSidebar({ sessions: [session] });
    expect(
      rowElement(session.sessionId).querySelector('[aria-label="Last run failed"]')
    ).not.toBeNull();

    renderSidebar({
      sessions: [{ ...session, sessionStatus: 'busy', latestRunFailureKind: null }],
    });
    expect(
      rowElement(session.sessionId).querySelector('[aria-label="Last run failed"]')
    ).toBeNull();
    expect(rowElement(session.sessionId).innerHTML).toContain('<title>Busy</title>');

    renderSidebar({ sessions: [{ ...session, latestRunFailureKind: null }] });
    expect(rowElement(session.sessionId).querySelector('[role="img"]')).toBeNull();
    expect(rowElement(session.sessionId).querySelector('[data-time-ago]')).not.toBeNull();
  });

  it.each([
    ['failed', 'Last run failed'],
    ['system_interrupted', 'Last run stopped unexpectedly'],
  ] as const)(
    'shows a %s warning during search only when the latest sibling has issues',
    (latestRunFailureKind, label) => {
      const visible = makeSession(0, { worktreeId: 'worktree_shared', sessionStatus: 'idle' });
      const hidden = makeSession(1, {
        worktreeId: 'worktree_shared',
        sessionStatus: 'idle',
        latestRunFailureKind,
      });
      const props = {
        sessions: [visible],
        searchQuery: visible.prompt,
        worktreeDetails: {
          worktree_shared: {
            name: 'Shared worktree',
            defaultTitle: null,
            prSession: null,
            sessions: [visible, hidden],
          },
        },
      } satisfies Partial<ChatSidebarProps>;
      renderSidebar(props);

      const row = dom.container.querySelector('[data-worktree-id="worktree_shared"]');
      expect(row).not.toBeNull();
      expect(row?.querySelector(`[role="img"][aria-label="${label}"]`)).toBeNull();
      expect(row?.querySelector('[data-time-ago]')).not.toBeNull();
      expect(row?.textContent).not.toContain(hidden.prompt);
      expect(dom.container.querySelector(`[data-session-pr="${hidden.sessionId}"]`)).toBeNull();

      renderSidebar({ ...props, activeSessions: [activeSession(hidden)] });
      expect(row?.querySelector(`[role="img"][aria-label="${label}"]`)).toBeNull();

      const latest = {
        ...hidden,
        createdAt: new Date(new Date(visible.createdAt).getTime() + 1_000).toISOString(),
        updatedAt: new Date(new Date(visible.updatedAt).getTime() + 1_000).toISOString(),
      };
      renderSidebar({
        ...props,
        worktreeDetails: {
          worktree_shared: {
            ...props.worktreeDetails.worktree_shared,
            sessions: [visible, latest],
          },
        },
      });
      expect(row?.querySelector(`[role="img"][aria-label="${label}"]`)).not.toBeNull();
      expect(row?.querySelector('[data-time-ago]')).toBeNull();

      renderSidebar({
        ...props,
        worktreeDetails: {
          worktree_shared: {
            ...props.worktreeDetails.worktree_shared,
            sessions: [visible, { ...latest, latestRunFailureKind: null }],
          },
        },
      });
      expect(dom.container.querySelector(`[aria-label="${label}"]`)).toBeNull();
      expect(row?.querySelector('[data-time-ago]')).not.toBeNull();
    }
  );

  it.each(['busy', 'retry', 'question', 'permission'])(
    'renders grouped %s activity ahead of a hidden failed sibling',
    status => {
      const visible = makeSession(0, { worktreeId: 'worktree_shared' });
      const hidden = makeSession(1, { sessionStatus: 'idle', latestRunFailureKind: 'failed' });
      renderSidebar({
        sessions: [visible],
        foregroundSession: { sessionId: visible.sessionId, status },
        worktreeDetails: {
          worktree_shared: {
            name: 'Shared worktree',
            defaultTitle: null,
            prSession: null,
            sessions: [visible, hidden],
          },
        },
      });

      const row = dom.container.querySelector('[data-worktree-id="worktree_shared"]');
      expect(row?.querySelector('[aria-label="Last run failed"]')).toBeNull();
      if (status === 'busy' || status === 'retry') {
        expect(row?.innerHTML).toContain(
          status === 'busy' ? '<title>Busy</title>' : '<title>Retrying</title>'
        );
      } else {
        const label = status === 'question' ? 'Waiting for answer' : 'Waiting for permission';
        expect(row?.querySelector(`[aria-label="${label}"]`)).not.toBeNull();
      }
    }
  );

  it('does not render warnings for normal interruptions in standalone or grouped rows', () => {
    renderSidebar({
      sessions: [
        makeSession(0, { sessionStatus: 'idle', latestRunFailureKind: null }),
        makeSession(1, {
          sessionStatus: 'idle',
          latestRunFailureKind: null,
          worktreeId: 'worktree_shared',
        }),
      ],
    });
    expect(dom.container.querySelector('[role="img"]')).toBeNull();
    expect(dom.container.querySelectorAll('[data-time-ago]')).toHaveLength(2);
  });

  function rowElement(sessionId: string): HTMLElement {
    let node: Element | null = dom.container.querySelector(`[data-session-pr="${sessionId}"]`);
    while (node) {
      if (typeof node.className === 'string' && node.className.includes('hover:bg-accent')) {
        return node as HTMLElement;
      }
      node = node.parentElement;
    }
    throw new Error(`Session row missing for ${sessionId}`);
  }

  function menuItem(row: HTMLElement, label: string): HTMLElement {
    const item = Array.from(row.querySelectorAll('[role="menuitem"]')).find(
      candidate => candidate.textContent?.trim() === label
    );
    if (!item) throw new Error(`Menu item missing: ${label}`);
    return item as HTMLElement;
  }

  function click(target: Element): void {
    act(() => {
      target.dispatchEvent(new window.Event('click', { bubbles: true }));
    });
  }

  function dispatchKey(target: Element, key: string): void {
    act(() => {
      const event = new window.Event('keydown', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'key', { value: key });
      target.dispatchEvent(event);
    });
  }

  function setInputValue(input: Element, value: string): void {
    act(() => {
      const key = Object.getOwnPropertyNames(input).find(name => name.startsWith('__reactProps'));
      const props = key
        ? (
            input as unknown as Record<
              string,
              { onChange?: (event: { target: { value: string } }) => void }
            >
          )[key]
        : undefined;
      if (!props?.onChange) throw new Error('Input change handler missing');
      props.onChange({ target: { value } });
    });
  }

  function folderDragFixture() {
    const ids = [
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    ];
    const sessions = ids.map((id, index) =>
      makeSession(index, {
        worktreeId: `worktree_${id}`,
        cloudAgentSessionId: `workspace_${id}`,
      })
    );
    const workspaceFolders = {
      folders: [
        {
          id: ids[0],
          name: 'Product',
          color: 'blue' as const,
          kind: 'manual' as const,
          smartPreset: null,
          sortMode: 'manual' as const,
          worktreeIds: [] as string[],
          manualWorktreeOrder: [],
        },
        {
          id: ids[1],
          name: 'Needs you',
          color: 'yellow' as const,
          kind: 'smart' as const,
          smartPreset: 'needs_you' as const,
          sortMode: 'activity' as const,
          worktreeIds: [] as string[],
          manualWorktreeOrder: [],
        },
      ],
      isLoading: false,
      isFirstLoadPending: false,
      isError: false,
      isSaving: false,
      collapsedFolderIds: [],
      toggleFolder: jest.fn(),
      saveFolder: jest.fn(async () => true),
      setFolderColor: jest.fn(async () => true),
      deleteFolder: jest.fn(async () => true),
      moveWorktree: jest.fn(
        async (_worktreeId: string, _folderId: string | null, _position?: string | null) => false
      ),
      moveSession: jest.fn(async () => false),
      initializeWorktreePositions: jest.fn(
        async (_orderedWorktreeIds: readonly string[], _folderId: string | null) => true
      ),
      reorderFolders: jest.fn(async () => true),
      reorderSmartFolderWorktrees: jest.fn(async () => true),
      refresh: jest.fn(async () => undefined),
    } satisfies NonNullable<ChatSidebarProps['workspaceFolders']>;
    const dataTransfer = {
      setData: jest.fn(),
      setDragImage: jest.fn(),
      effectAllowed: '',
      dropEffect: '',
    };
    const dragEvent = (target: Element, type: string) => {
      const event = new window.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        dataTransfer: { value: dataTransfer },
        clientX: { value: 30 },
        clientY: { value: 45 },
      });
      act(() => {
        target.dispatchEvent(event);
      });
    };
    return { sessions, workspaceFolders, dataTransfer, dragEvent };
  }

  it.each(['needs_you', 'in_review', 'done'] as const)(
    'excludes %s smart folders from move destinations without hiding their sidebar section',
    smartPreset => {
      const { sessions, workspaceFolders } = folderDragFixture();
      const smartFolder = { ...workspaceFolders.folders[1], smartPreset };
      const workspaceGroups = sessions.map(session => ({
        type: 'worktree' as const,
        worktreeId: session.worktreeId!,
        sessions: [session],
        latestSession: session,
      }));
      renderSidebar({
        sessions,
        workspaceGroups,
        workspaceFolders: {
          ...workspaceFolders,
          folders: [workspaceFolders.folders[0], smartFolder],
        },
      });

      const row = dom.container.querySelector(`[data-worktree-id="${sessions[0].worktreeId}"]`);
      if (!row) throw new Error('Workspace row missing');
      const destinations = () =>
        Array.from(row.querySelectorAll('[role="menuitemradio"]'), item => item.textContent);

      expect(destinations()).toEqual(['Ungrouped', 'Product']);
      expect(dom.container.querySelector(`[data-folder-id="${smartFolder.id}"]`)).not.toBeNull();

      renderSidebar({
        sessions,
        workspaceGroups,
        workspaceFolders: { ...workspaceFolders, folders: [smartFolder] },
      });
      expect(destinations()).toEqual([]);
      expect(row.textContent).not.toContain('Move to folder');
      expect(dom.container.querySelector(`[data-folder-id="${smartFolder.id}"]`)).not.toBeNull();

      renderSidebar({
        sessions,
        workspaceGroups,
        workspaceFolders: { ...workspaceFolders, folders: [] },
      });
      expect(destinations()).toEqual([]);
      expect(row.textContent).not.toContain('Move to folder');
    }
  );

  it('requires confirmation before deleting a folder and allows cancellation', async () => {
    const { sessions, workspaceFolders } = folderDragFixture();
    renderSidebar({ sessions, workspaceFolders });
    const folder = dom.container.querySelector<HTMLElement>('[data-folder-id]');
    if (!folder) throw new Error('Folder missing');

    click(menuItem(folder, 'Delete folder'));
    expect(workspaceFolders.deleteFolder).not.toHaveBeenCalled();

    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) throw new Error('Delete confirmation missing');
    expect(dialog.textContent).toContain('Product');
    expect(dialog.textContent).toContain('will move to Ungrouped, not be deleted');
    const cancel = Array.from(dialog.querySelectorAll('button')).find(
      button => button.textContent === 'Cancel'
    );
    if (!cancel) throw new Error('Cancel button missing');
    click(cancel);
    expect(workspaceFolders.deleteFolder).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    click(menuItem(folder, 'Delete folder'));
    const confirm = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')
    ).find(button => button.textContent === 'Delete folder');
    if (!confirm) throw new Error('Delete confirmation button missing');
    await act(async () => {
      confirm.click();
    });
    expect(workspaceFolders.deleteFolder).toHaveBeenCalledTimes(1);
    expect(workspaceFolders.deleteFolder).toHaveBeenCalledWith(workspaceFolders.folders[0].id);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('removes a smart folder from the sidebar without confirmation', async () => {
    const { sessions, workspaceFolders } = folderDragFixture();
    renderSidebar({ sessions, workspaceFolders, workspaceGroups: [] });
    const smartFolder = workspaceFolders.folders[1];
    const folder = dom.container.querySelector<HTMLElement>(`[data-folder-id="${smartFolder.id}"]`);
    if (!folder) throw new Error('Smart folder missing');
    expect(workspaceFolders.deleteFolder).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => {
      menuItem(folder, 'Remove from sidebar').click();
    });

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(workspaceFolders.deleteFolder).toHaveBeenCalledTimes(1);
    expect(workspaceFolders.deleteFolder).toHaveBeenCalledWith(smartFolder.id);
  });

  it.each([0, 1])('drags only ungrouped workspace row %i from its title into a folder', index => {
    const { sessions, workspaceFolders, dataTransfer, dragEvent } = folderDragFixture();
    const onOpenSession = jest.fn();
    renderSidebar({ sessions, workspaceFolders, onOpenSession });
    const session = sessions[index];
    const row = dom.container.querySelector<HTMLElement>(
      `[data-worktree-id="${session.worktreeId}"]`
    );
    const title = row?.querySelector('button span');
    const folder = dom.container.querySelector('[data-folder-id]');
    if (!row || !title || !folder) throw new Error('Drag source or target missing');
    row.getBoundingClientRect = () => ({ left: 10, top: 20, width: 200, height: 36 }) as DOMRect;

    expect(row.getAttribute('draggable')).toBe('true');
    expect(dom.container.querySelector('.overflow-y-auto')?.classList.contains('select-none')).toBe(
      true
    );
    dragEvent(title, 'dragstart');

    expect(dataTransfer.effectAllowed).toBe('move');
    expect(dataTransfer.setData).toHaveBeenCalledTimes(1);
    expect(dataTransfer.setData).toHaveBeenCalledWith(
      'application/x-kilo-workspace-folder',
      JSON.stringify({ type: 'worktree', id: session.worktreeId })
    );
    expect(dataTransfer.setDragImage).toHaveBeenCalledWith(row, 20, 25);
    expect(dom.container.querySelectorAll('[data-worktree-id].opacity-50')).toHaveLength(1);

    dragEvent(folder, 'dragover');
    expect(dataTransfer.dropEffect).toBe('move');
    dragEvent(folder, 'drop');

    expect(workspaceFolders.moveWorktree).toHaveBeenCalledTimes(1);
    expect(workspaceFolders.moveWorktree).toHaveBeenCalledWith(
      session.worktreeId,
      workspaceFolders.folders[0].id
    );
    expect(onOpenSession).not.toHaveBeenCalled();
    expect(dom.container.querySelectorAll('[data-worktree-id].opacity-50')).toHaveLength(0);
  });

  it('uses only the folder header as its drag image and clears cancelled drags', () => {
    const { sessions, workspaceFolders, dataTransfer, dragEvent } = folderDragFixture();
    workspaceFolders.folders[0].worktreeIds.push(sessions[0].worktreeId!);
    renderSidebar({ sessions, workspaceFolders });
    const header = dom.container.querySelector<HTMLElement>('[data-folder-id] > div');
    if (!header) throw new Error('Folder header missing');
    header.getBoundingClientRect = () => ({ left: 10, top: 20, width: 200, height: 36 }) as DOMRect;

    dragEvent(header, 'dragstart');
    expect(dataTransfer.setDragImage).toHaveBeenCalledWith(header, 20, 25);
    expect(header.querySelector('[data-worktree-id]')).toBeNull();
    dragEvent(header, 'dragend');
    expect(dom.container.querySelector('[data-folder-id].opacity-50')).toBeNull();
    expect(workspaceFolders.moveWorktree).not.toHaveBeenCalled();
    expect(workspaceFolders.reorderFolders).not.toHaveBeenCalled();
  });

  it('drags a standalone ses_ row by its cloud workspace id', () => {
    const { sessions, workspaceFolders, dataTransfer, dragEvent } = folderDragFixture();
    const workspaceId = 'workspace_99999999-9999-4999-8999-999999999999';
    const standalone = makeSession(3, {
      prompt: 'Standalone cloud chat',
      cloudAgentSessionId: workspaceId,
    });
    renderSidebar({ sessions: [...sessions, standalone], workspaceFolders });
    const row = Array.from(dom.container.querySelectorAll<HTMLElement>('[draggable="true"]')).find(
      element => element.textContent?.includes(standalone.prompt)
    );
    const folder = dom.container.querySelector('[data-folder-id]');
    if (!row || !folder) throw new Error('Drag source or target missing');
    row.getBoundingClientRect = () => ({ left: 10, top: 20, width: 200, height: 36 }) as DOMRect;

    dragEvent(row, 'dragstart');
    expect(dataTransfer.setData).toHaveBeenCalledWith(
      'application/x-kilo-workspace-folder',
      JSON.stringify({ type: 'session', id: workspaceId })
    );
    expect(dom.container.querySelectorAll('.opacity-50')).toHaveLength(1);

    dragEvent(folder, 'dragover');
    dragEvent(folder, 'drop');

    expect(workspaceFolders.moveSession).toHaveBeenCalledTimes(1);
    expect(workspaceFolders.moveSession).toHaveBeenCalledWith(
      workspaceId,
      workspaceFolders.folders[0].id
    );
    expect(workspaceFolders.moveSession).not.toHaveBeenCalledWith(
      standalone.sessionId,
      expect.anything()
    );
    expect(dom.container.querySelectorAll('.opacity-50')).toHaveLength(0);
  });

  it('keeps immutable standalone rows flat when live inputs churn with stable callbacks', () => {
    // Every row carries a cloud id so the drag props are defined; otherwise a
    // per-row onDragStart identity leak would go unnoticed by this test.
    const sessions = makeSessions(SESSION_COUNT).map((session, index) => ({
      ...session,
      cloudAgentSessionId: `workspace_00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
    }));
    const onOpenSession = jest.fn();
    const onDeleteSession = jest.fn();
    const onRenameSession = jest.fn(async () => undefined);
    const activeSessions = [activeSession(sessions[0]!), activeSession(sessions[1]!)];
    const foregroundSession = { sessionId: sessions[0]!.sessionId, status: 'busy' };

    renderSidebar({
      sessions,
      activeSessions,
      foregroundSession,
      onOpenSession,
      onDeleteSession,
      onRenameSession,
    });

    expect(indicatorMock).toHaveBeenCalledTimes(SESSION_COUNT);

    indicatorMock.mockClear();

    renderSidebar({
      sessions,
      activeSessions: [...activeSessions],
      foregroundSession: { sessionId: sessions[0]!.sessionId, status: 'idle' },
      onOpenSession,
      onDeleteSession,
      onRenameSession,
    });

    expect(indicatorMock).not.toHaveBeenCalled();
  });

  it('re-renders only the row whose active selection changed', () => {
    const sessions = makeSessions(SESSION_COUNT);
    const props = {
      sessions,
      onOpenSession: jest.fn(),
      onDeleteSession: jest.fn(),
      onRenameSession: jest.fn(async () => undefined),
    };

    renderSidebar(props);
    indicatorMock.mockClear();

    renderSidebar({ ...props, currentSessionId: sessions[7]!.sessionId });

    expect(indicatorMock).toHaveBeenCalledTimes(1);
    expect(indicatorMock.mock.calls[0]![0].session.sessionId).toBe(sessions[7]!.sessionId);
  });

  it('re-renders only the row whose live flag changed', () => {
    const sessions = makeSessions(SESSION_COUNT);
    const props = {
      sessions,
      onOpenSession: jest.fn(),
      onDeleteSession: jest.fn(),
      onRenameSession: jest.fn(async () => undefined),
    };

    renderSidebar({ ...props, activeSessions: [] });
    indicatorMock.mockClear();

    renderSidebar({ ...props, activeSessions: [activeSession(sessions[9]!)] });

    expect(indicatorMock).toHaveBeenCalledTimes(1);
    expect(indicatorMock.mock.calls[0]![0].session.sessionId).toBe(sessions[9]!.sessionId);
  });

  it('re-renders only the row whose deleting flag changed', () => {
    const sessions = makeSessions(SESSION_COUNT);
    const props = {
      sessions,
      onOpenSession: jest.fn(),
      onDeleteSession: jest.fn(),
      onRenameSession: jest.fn(async () => undefined),
    };

    renderSidebar(props);
    indicatorMock.mockClear();

    renderSidebar({ ...props, deletingSessionIds: [sessions[3]!.sessionId] });

    expect(indicatorMock).toHaveBeenCalledTimes(1);
    expect(indicatorMock.mock.calls[0]![0].session.sessionId).toBe(sessions[3]!.sessionId);
  });

  it('re-renders only the replaced row and shows its new title', () => {
    const sessions = makeSessions(SESSION_COUNT);
    const props = {
      sessions,
      onOpenSession: jest.fn(),
      onDeleteSession: jest.fn(),
      onRenameSession: jest.fn(async () => undefined),
    };

    renderSidebar(props);
    indicatorMock.mockClear();

    renderSidebar({
      ...props,
      sessions: replaceSession(sessions, 5, { prompt: 'Renamed five' }),
    });

    expect(indicatorMock).toHaveBeenCalledTimes(1);
    expect(indicatorMock.mock.calls[0]![0].session.sessionId).toBe(sessions[5]!.sessionId);
    expect(dom.container.textContent).toContain('Renamed five');
  });

  it('exposes the full truncated session title on hover', () => {
    const longTitle = 'A very long session title that gets visually cut off in the sidebar';
    const sessions = makeSessions(3);
    const overrides = replaceSession(sessions, 0, { prompt: longTitle });

    renderSidebar({ sessions: overrides });

    const storedTitle = Array.from(dom.container.querySelectorAll('span')).find(
      candidate => candidate.textContent === longTitle
    );
    expect(storedTitle?.getAttribute('title')).toBe(longTitle);

    renderSidebar({
      sessions: [],
      activeSessions: [activeSession({ ...sessions[1]!, prompt: longTitle })],
    });

    const remoteTitle = Array.from(dom.container.querySelectorAll('span')).find(
      candidate => candidate.textContent === longTitle
    );
    expect(remoteTitle?.getAttribute('title')).toBe(longTitle);
  });

  it('scopes live rows to the organization the sidebar is showing', () => {
    const sessions = makeSessions(2);
    const personal = activeSession(sessions[0]!);
    const organization = activeSession(sessions[1]!, 'idle', 'org-1');

    // Personal view (no organization prop) keeps the personal row and leaves
    // the organization row to the stored list.
    renderSidebar({ sessions: [], activeSessions: [personal, organization] });
    expect(dom.container.textContent).toContain(sessions[0]!.prompt);
    expect(dom.container.textContent).not.toContain(sessions[1]!.prompt);

    renderSidebar({
      sessions: [],
      organizationId: 'org-1',
      activeSessions: [personal, organization],
    });
    expect(dom.container.textContent).toContain(sessions[1]!.prompt);
    expect(dom.container.textContent).not.toContain(sessions[0]!.prompt);
  });

  it('updates the visible status of a live row without touching its siblings', () => {
    const sessions = [
      makeSession(0, { sessionStatus: 'busy' }),
      makeSession(1, { sessionStatus: 'question' }),
      makeSession(2),
    ];
    const props = {
      onOpenSession: jest.fn(),
      onDeleteSession: jest.fn(),
      onRenameSession: jest.fn(async () => undefined),
      activeSessions: [activeSession(sessions[0]!)],
    };

    renderSidebar({ ...props, sessions });
    expect(rowElement(sessions[0]!.sessionId).innerHTML).toContain('<title>Busy</title>');
    expect(rowElement(sessions[1]!.sessionId).innerHTML).toContain(
      'aria-label="Waiting for answer"'
    );

    indicatorMock.mockClear();

    renderSidebar({
      ...props,
      sessions: replaceSession(sessions, 0, { sessionStatus: null }),
      activeSessions: [activeSession(sessions[0]!)],
    });

    expect(indicatorMock).toHaveBeenCalledTimes(1);
    expect(indicatorMock.mock.calls[0]![0].session.sessionId).toBe(sessions[0]!.sessionId);
    const liveRow = rowElement(sessions[0]!.sessionId);
    expect(liveRow.innerHTML).not.toContain('<title>Busy</title>');
    expect(liveRow.querySelector('[data-time-ago]')).toBeNull();
    expect(rowElement(sessions[2]!.sessionId).querySelector('[data-time-ago]')).not.toBeNull();
  });

  it('opens the clicked row through onOpenSession with its session id', () => {
    const sessions = makeSessions(3);
    const onOpenSession = jest.fn();

    renderSidebar({ sessions, onOpenSession, onRenameSession: jest.fn(async () => undefined) });

    click(rowElement(sessions[1]!.sessionId));

    expect(onOpenSession).toHaveBeenCalledTimes(1);
    expect(onOpenSession).toHaveBeenCalledWith(sessions[1]!.sessionId);
  });

  it('does not open a row from its actions trigger or menu item, and deletes by session id', () => {
    const sessions = makeSessions(2);
    const onOpenSession = jest.fn();
    const onDeleteSession = jest.fn();

    renderSidebar({
      sessions,
      onOpenSession,
      onDeleteSession,
      onRenameSession: jest.fn(async () => undefined),
    });

    const row = rowElement(sessions[1]!.sessionId);
    const trigger = row.querySelector(
      `button[aria-label="Session actions for ${sessions[1]!.prompt}"]`
    );
    if (!trigger) throw new Error('Session actions trigger missing');

    click(trigger);
    click(menuItem(row, 'Delete session'));

    expect(onOpenSession).not.toHaveBeenCalled();
    expect(onDeleteSession).toHaveBeenCalledTimes(1);
    expect(onDeleteSession).toHaveBeenCalledWith(sessions[1]!.sessionId);
  });

  it('renames through the row menu, saving the trimmed title and cancelling with Escape', async () => {
    const sessions = makeSessions(2);
    const onRenameSession = jest.fn(async () => undefined);

    renderSidebar({ sessions, onOpenSession: jest.fn(), onRenameSession });

    click(menuItem(rowElement(sessions[0]!.sessionId), 'Rename'));

    const input = dom.container.querySelector('input');
    if (!input) throw new Error('Rename input missing');

    indicatorMock.mockClear();
    setInputValue(input, '  Renamed zero  ');
    expect(indicatorMock).not.toHaveBeenCalled();
    expect(input.getAttribute('value')).toBe('  Renamed zero  ');
    dispatchKey(input, 'Enter');
    await act(async () => undefined);

    expect(onRenameSession).toHaveBeenCalledTimes(1);
    expect(onRenameSession).toHaveBeenCalledWith(sessions[0]!.sessionId, 'Renamed zero');

    click(menuItem(rowElement(sessions[0]!.sessionId), 'Rename'));
    const secondInput = dom.container.querySelector('input');
    if (!secondInput) throw new Error('Second rename input missing');

    dispatchKey(secondInput, 'Escape');

    expect(onRenameSession).toHaveBeenCalledTimes(1);
    expect(rowElement(sessions[0]!.sessionId).querySelector('input')).toBeNull();
  });

  it('does not open a row while it is editing or deleting', () => {
    const sessions = makeSessions(2);
    const onOpenSession = jest.fn();

    renderSidebar({
      sessions,
      onOpenSession,
      deletingSessionIds: [sessions[0]!.sessionId],
      onRenameSession: jest.fn(async () => undefined),
    });

    click(rowElement(sessions[0]!.sessionId));
    expect(onOpenSession).not.toHaveBeenCalled();

    renderSidebar({ sessions, onOpenSession, onRenameSession: jest.fn(async () => undefined) });
    click(menuItem(rowElement(sessions[1]!.sessionId), 'Rename'));

    const input = dom.container.querySelector('input');
    if (!input) throw new Error('Rename input missing');
    const editingRow = input.parentElement?.parentElement;
    if (!editingRow) throw new Error('Editing row missing');

    click(editingRow);
    expect(onOpenSession).not.toHaveBeenCalled();
  });
});

describe('ChatSidebar stacked workspaces', () => {
  let dom: ReturnType<typeof installDom>;
  let root: Root;

  beforeAll(() => {
    dom = installDom();
  });

  afterAll(() => dom.cleanup());

  beforeEach(() => {
    mockPathname = '/cloud';
    mockStackedSource = { source: undefined, isPending: false };
    mockRouterPush.mockClear();
    indicatorMock.mockClear();
    tooltipMock.mockClear();
    root = createRoot(dom.container);
    getDefaultStore().set(stackedWorkspaceTargetAtom, null);
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  function renderSidebar(overrides: Partial<ChatSidebarProps> = {}): void {
    act(() => {
      root.render(React.createElement(ChatSidebar, baseProps(overrides)));
    });
  }

  function stackedGroup(): NonNullable<ChatSidebarProps['workspaceGroups']>[number] {
    const rootSession = makeSession(0, {
      worktreeId: 'worktree_root',
      repository: 'kilo/repo',
      branch: 'feature/base',
    });
    const childSession = makeSession(1, {
      worktreeId: 'worktree_child',
      repository: 'kilo/repo',
      branch: 'feature/child',
    });
    const prSession = {
      ...rootSession,
      associatedPr: {
        url: 'https://github.com/kilo/repo/pull/12',
        number: 12,
        state: 'open',
        title: 'Root PR',
        headSha: null,
        lastSyncedAt: '2026-01-02T00:00:00.000Z',
        reviewDecision: null,
        reviewDecisionPending: false,
        platform: 'github',
        observations: null,
      },
    };
    return {
      type: 'worktree',
      worktreeId: 'worktree_root',
      sessions: [rootSession],
      latestSession: rootSession,
      details: {
        name: 'Root workspace',
        defaultTitle: null,
        branch: 'feature/base',
        parentWorktreeId: null,
        baseBranch: null,
        prSession,
        sessions: [rootSession],
      },
      stackLayers: [
        {
          type: 'worktree',
          worktreeId: 'worktree_child',
          sessions: [childSession],
          latestSession: childSession,
          details: {
            name: 'Child workspace',
            defaultTitle: null,
            branch: 'feature/child',
            parentWorktreeId: 'worktree_root',
            baseBranch: 'feature/base',
            prSession: null,
            sessions: [childSession],
          },
        },
      ],
    };
  }

  it('uses the base row as the stack header and collapses its layers without a feature flag', () => {
    renderSidebar({
      sessions: [],
      workspaceGroups: [stackedGroup()],
    });

    expect(dom.container.querySelectorAll('[data-worktree-id="worktree_root"]')).toHaveLength(1);
    expect(dom.container.querySelectorAll('[data-worktree-id="worktree_child"]')).toHaveLength(1);
    const baseRow = () => dom.container.querySelector('[data-worktree-id="worktree_root"]');
    const collapse = baseRow()?.querySelector<HTMLButtonElement>(
      '[aria-label="Collapse stack Root workspace"]'
    );
    expect(collapse).not.toBeNull();
    expect(
      dom.container.querySelector(
        '[aria-label="Layers on Root workspace"] [data-worktree-id="worktree_root"]'
      )
    ).toBeNull();
    expect(baseRow()?.querySelector('[title="2 workspaces in stack"]')).toBeNull();
    act(() => collapse?.click());

    expect(collapse?.getAttribute('aria-expanded')).toBe('false');
    expect(
      dom.container
        .querySelector('[aria-label="Layers on Root workspace"]')
        ?.getAttribute('data-state')
    ).toBe('closed');
    expect(dom.container.querySelectorAll('[data-worktree-id="worktree_root"]')).toHaveLength(1);
    expect(baseRow()?.querySelector('[title="2 workspaces in stack"]')?.textContent).toBe('2');
    const expand = baseRow()?.querySelector<HTMLButtonElement>(
      '[aria-label="Expand stack Root workspace"]'
    );
    expect(expand).not.toBeNull();
    act(() => expand?.click());
    expect(dom.container.querySelectorAll('[data-worktree-id]')).toHaveLength(2);
  });

  it('sets the stacked workspace target from the worktree row menu', () => {
    renderSidebar({
      sessions: [],
      organizationId: 'org_1',
      workspaceGroups: [stackedGroup()],
    });

    const item = [...dom.container.querySelectorAll('[role="menuitem"]')].find(node =>
      node.textContent?.includes('New stacked workspace')
    );
    expect(item).toBeDefined();
    act(() => (item as HTMLElement).click());

    expect(getDefaultStore().get(stackedWorkspaceTargetAtom)).toEqual({
      worktreeId: 'worktree_root',
      branch: 'feature/base',
      repository: 'kilo/repo',
      prNumber: 12,
      organizationId: 'org_1',
    });
    expect(mockRouterPush).toHaveBeenCalledWith('/organizations/org_1/cloud');
  });
});

describe('ChatSidebar phase 4 drag ordering', () => {
  let dom: ReturnType<typeof installDom>;
  let root: Root;

  beforeAll(() => {
    dom = installDom();
  });

  afterAll(() => dom.cleanup());

  beforeEach(() => {
    mockPathname = '/cloud';
    mockStackedSource = { source: undefined, isPending: false };
    mockRouterPush.mockClear();
    indicatorMock.mockClear();
    tooltipMock.mockClear();
    root = createRoot(dom.container);
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  function renderSidebar(overrides: Partial<ChatSidebarProps> = {}): void {
    act(() => {
      root.render(React.createElement(ChatSidebar, baseProps(overrides)));
    });
  }

  function phase4Group(
    index: number,
    sidebarPosition: string | null,
    overrides: Partial<StoredSession> = {}
  ): NonNullable<ChatSidebarProps['workspaceGroups']>[number] {
    const session = makeSession(index, {
      worktreeId: `worktree_drag_${index}`,
      cloudAgentSessionId: `workspace_${index}`,
      ...overrides,
    });
    return {
      type: 'worktree',
      worktreeId: session.worktreeId!,
      sessions: [session],
      latestSession: session,
      details: {
        name: `Workspace ${index}`,
        defaultTitle: null,
        branch: `feature/${index}`,
        parentWorktreeId: null,
        baseBranch: null,
        folderId: null,
        sidebarPosition,
        createdAt: session.createdAt,
        prSession: null,
        sessions: [session],
      },
    };
  }

  function workspaceFolders() {
    return {
      folders: [] as WorkspaceFolder[],
      isLoading: false,
      isFirstLoadPending: false,
      isError: false,
      isSaving: false,
      collapsedFolderIds: [] as string[],
      toggleFolder: jest.fn(),
      saveFolder: jest.fn(async () => true),
      setFolderColor: jest.fn(async () => true),
      deleteFolder: jest.fn(async () => true),
      moveWorktree: jest.fn(
        async (_worktreeId: string, _folderId: string | null, _position?: string | null) => false
      ),
      moveSession: jest.fn(async () => false),
      initializeWorktreePositions: jest.fn(
        async (_orderedWorktreeIds: readonly string[], _folderId: string | null) => true
      ),
      reorderFolders: jest.fn(async () => true),
      reorderSmartFolderWorktrees: jest.fn(
        async (_folderId: string, _worktreeIds: readonly string[]) => true
      ),
      refresh: jest.fn(async () => undefined),
    } satisfies NonNullable<ChatSidebarProps['workspaceFolders']>;
  }

  it('keeps Ungrouped available for a filed workspace while manual folders are unavailable', () => {
    const group = phase4Group(0, null);
    if (!group.details) throw new Error('Workspace details missing');
    renderSidebar({
      workspaceGroups: [
        {
          ...group,
          details: { ...group.details, folderId: '11111111-1111-4111-8111-111111111111' },
        },
      ],
      workspaceFolders: workspaceFolders(),
    });

    const row = dom.container.querySelector(`[data-worktree-id="${group.worktreeId}"]`);
    if (!row) throw new Error('Workspace row missing');
    expect(row.textContent).toContain('Move to folder');
    expect(
      Array.from(row.querySelectorAll('[role="menuitemradio"]'), item => item.textContent)
    ).toEqual(['Ungrouped']);
  });

  function dragRows(
    source: Element,
    target: Element,
    clientY: number,
    afterDragOver?: () => void
  ): { dataTransfer: { setData: jest.Mock; setDragImage: jest.Mock } } {
    const dataTransfer = {
      setData: jest.fn(),
      setDragImage: jest.fn(),
      effectAllowed: '',
      dropEffect: '',
    };
    const event = (element: Element, type: string, y?: number) => {
      const next = new window.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(next, {
        dataTransfer: { value: dataTransfer },
        clientX: { value: 30 },
        clientY: { value: y ?? 0 },
      });
      act(() => {
        element.dispatchEvent(next);
      });
    };
    target.getBoundingClientRect = () =>
      ({ top: 0, left: 0, width: 200, height: 40, bottom: 40, right: 200, x: 0, y: 0 }) as DOMRect;
    event(source, 'dragstart');
    event(target, 'dragover', clientY);
    afterDragOver?.();
    event(target, 'drop', clientY);
    return { dataTransfer };
  }

  it.each(['manual', 'created', 'activity'] as const)(
    'limits Ungrouped to recent activity with %s ordering',
    workspaceOrder => {
      jest.useFakeTimers({ now: new Date(2026, 10, 9, 12) });
      try {
        const cutoff = new Date(2026, 10, 4).toISOString();
        const old = phase4Group(0, null, {
          createdAt: new Date(2026, 8, 1).toISOString(),
          lastActivityAt: new Date(2026, 8, 1).toISOString(),
          updatedAt: new Date().toISOString(),
        });
        const recent = phase4Group(1, null, {
          createdAt: new Date(2026, 8, 1).toISOString(),
          lastActivityAt: cutoff,
        });
        const beforeCutoff = phase4Group(2, null, {
          createdAt: new Date(2026, 10, 3, 23, 59, 59).toISOString(),
        });
        renderSidebar({ workspaceGroups: [old, recent, beforeCutoff], workspaceOrder });

        expect(dom.container.querySelector('[data-worktree-id="worktree_drag_0"]')).toBeNull();
        expect(dom.container.querySelector('[data-worktree-id="worktree_drag_1"]')).not.toBeNull();
        expect(dom.container.querySelector('[data-worktree-id="worktree_drag_2"]')).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    }
  );

  it('keeps old workspaces accessible in search and saved folders', () => {
    const old = phase4Group(0, null, {
      createdAt: new Date(2026, 0, 1).toISOString(),
    });
    renderSidebar({ workspaceGroups: [old], searchQuery: 'Workspace 0' });
    expect(dom.container.querySelector('[data-worktree-id="worktree_drag_0"]')).not.toBeNull();

    const folders = workspaceFolders();
    const folder = {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Saved',
      color: 'default',
      kind: 'manual',
      smartPreset: null,
      sortMode: 'manual',
      worktreeIds: [old.worktreeId],
      manualWorktreeOrder: [],
    } satisfies NonNullable<ChatSidebarProps['workspaceFolders']>['folders'][number];
    renderSidebar({
      workspaceGroups: [{ ...old, details: { ...old.details!, folderId: folder.id } }],
      workspaceFolders: { ...folders, folders: [folder] },
    });
    expect(
      dom.container.querySelector(`[data-folder-id="${folder.id}"] [data-worktree-id]`)
    ).not.toBeNull();
    expect(
      dom.container.querySelector('[data-folder-drop="ungrouped"] [data-worktree-id]')
    ).toBeNull();
  });

  it('shows a searchable empty state when all ungrouped workspaces have aged out', () => {
    renderSidebar({
      workspaceGroups: [phase4Group(0, null, { createdAt: new Date(2026, 0, 1).toISOString() })],
    });
    expect(dom.container.querySelector('[data-worktree-id]')).toBeNull();
    expect(dom.container.textContent).toContain(
      'No recent sessions. Use search to find older sessions.'
    );
  });

  it('interleaves recent workspaces and standalone sessions under shared date headings', () => {
    jest.useFakeTimers({ now: new Date(2026, 10, 9, 12) });
    try {
      const yesterday = phase4Group(0, null, {
        createdAt: new Date(2026, 10, 8, 12).toISOString(),
      });
      const thursday = phase4Group(1, null, {
        createdAt: new Date(2026, 10, 5, 12).toISOString(),
      });
      const todayWorkspace = phase4Group(4, null, {
        createdAt: new Date(2026, 10, 9, 9).toISOString(),
      });
      const today = makeSession(2, { createdAt: new Date(2026, 10, 9, 10).toISOString() });
      const friday = makeSession(3, { createdAt: new Date(2026, 10, 6, 12).toISOString() });
      renderSidebar({
        workspaceGroups: [thursday, yesterday, todayWorkspace],
        workspaceOrder: 'activity',
        sessions: [...yesterday.sessions, ...thursday.sessions, friday, today],
      });

      const ungrouped = dom.container.querySelector('[data-folder-drop="ungrouped"]');
      const sections = Array.from(ungrouped?.children ?? []).filter(element =>
        element.querySelector('[data-worktree-id], [title^="Prompt"]')
      );
      expect(sections.map(section => section.firstElementChild?.textContent)).toEqual([
        'Today',
        'Yesterday',
        'Friday',
        'Thursday',
      ]);
      expect(
        sections.map(section =>
          Array.from(section.querySelectorAll('[data-worktree-id], [title^="Prompt"]')).map(
            row => row.getAttribute('title') ?? row.querySelector('button span')?.textContent
          )
        )
      ).toEqual([[today.prompt, 'Workspace 4'], ['Workspace 0'], [friday.prompt], ['Workspace 1']]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps a stack visible when a child workspace has recent activity', () => {
    const old = phase4Group(0, null, { createdAt: new Date(2026, 0, 1).toISOString() });
    const child = phase4Group(1, null);
    renderSidebar({
      workspaceGroups: [{ ...old, stackLayers: [child] }],
      workspaceOrder: 'activity',
    });
    expect(dom.container.querySelector('[data-worktree-id="worktree_drag_0"]')).not.toBeNull();
    const ungrouped = dom.container.querySelector('[data-folder-drop="ungrouped"]');
    expect(ungrouped?.textContent).toContain('Today');
    expect(ungrouped?.textContent).not.toContain('Older');
  });

  it('preserves manual workspace positions and labels the separate sessions list', () => {
    const first = phase4Group(0, 'a2');
    const second = phase4Group(1, 'a1');
    renderSidebar({
      workspaceGroups: [first, second],
      workspaceOrder: 'manual',
      sessions: [makeSession(2)],
    });
    const ungrouped = dom.container.querySelector('[data-folder-drop="ungrouped"]');
    expect(
      Array.from(ungrouped?.querySelectorAll('[data-worktree-id]') ?? []).map(row =>
        row.getAttribute('data-worktree-id')
      )
    ).toEqual([second.worktreeId, first.worktreeId]);
    expect(ungrouped?.textContent).toContain('Sessions');
  });

  it('does not let workspace dates consume the standalone-session weekday headings', () => {
    jest.useFakeTimers({ now: new Date(2026, 10, 9, 12) });
    try {
      const workspaces = [7, 6, 5].map((day, index) =>
        phase4Group(index, null, { createdAt: new Date(2026, 10, day, 12).toISOString() })
      );
      renderSidebar({
        workspaceGroups: workspaces,
        workspaceOrder: 'manual',
        sessions: [
          ...workspaces.flatMap(group => group.sessions),
          makeSession(3, { createdAt: new Date(2026, 10, 4, 12).toISOString() }),
        ],
      });
      const ungrouped = dom.container.querySelector('[data-folder-drop="ungrouped"]');
      expect(ungrouped?.textContent).toContain('Wednesday');
      expect(ungrouped?.textContent).not.toContain('Older');
    } finally {
      jest.useRealTimers();
    }
  });

  it('initializes the whole unpositioned container on the first drag, writing the desired order', () => {
    const folders = workspaceFolders();
    renderSidebar({
      sessions: [],
      workspaceFolders: folders,
      workspaceGroups: [phase4Group(0, null), phase4Group(1, null)],
    });

    const rows = dom.container.querySelectorAll<HTMLElement>('[data-worktree-id]');
    const sourceTitle = rows[0]?.querySelector('button span');
    if (!rows[0] || !rows[1] || !sourceTitle) throw new Error('Rows missing');

    dragRows(sourceTitle, rows[1], 35);

    expect(folders.initializeWorktreePositions).toHaveBeenCalledTimes(1);
    expect(folders.initializeWorktreePositions).toHaveBeenCalledWith(
      ['worktree_drag_1', 'worktree_drag_0'],
      null
    );
    expect(folders.moveWorktree).not.toHaveBeenCalled();
  });

  it('writes only the dragged row when the container is already positioned', () => {
    const folders = workspaceFolders();
    renderSidebar({
      sessions: [],
      workspaceFolders: folders,
      workspaceGroups: [phase4Group(0, 'a1'), phase4Group(1, 'a2')],
    });

    const rows = dom.container.querySelectorAll<HTMLElement>('[data-worktree-id]');
    const sourceTitle = rows[0]?.querySelector('button span');
    if (!rows[0] || !rows[1] || !sourceTitle) throw new Error('Rows missing');

    dragRows(sourceTitle, rows[1], 35);

    expect(folders.initializeWorktreePositions).not.toHaveBeenCalled();
    expect(folders.moveWorktree).toHaveBeenCalledTimes(1);
    const [worktreeId, folderId, position] = folders.moveWorktree.mock.calls[0] ?? [];
    expect(worktreeId).toBe('worktree_drag_0');
    expect(folderId).toBeNull();
    expect(typeof position).toBe('string');
    expect((position as string) > 'a2').toBe(true);
  });

  it('includes aged-out workspaces when initializing Ungrouped positions', () => {
    const folders = workspaceFolders();
    renderSidebar({
      workspaceFolders: folders,
      workspaceGroups: [
        phase4Group(0, null),
        phase4Group(1, null),
        phase4Group(2, 'a1', { createdAt: new Date(2026, 0, 1).toISOString() }),
      ],
    });

    const rows = dom.container.querySelectorAll<HTMLElement>('[data-worktree-id]');
    expect(rows).toHaveLength(2);
    const sourceTitle = rows[0]?.querySelector('button span');
    if (!rows[0] || !rows[1] || !sourceTitle) throw new Error('Rows missing');

    dragRows(sourceTitle, rows[1], 35);

    expect(folders.initializeWorktreePositions).toHaveBeenCalledTimes(1);
    expect(folders.initializeWorktreePositions).toHaveBeenCalledWith(
      ['worktree_drag_1', 'worktree_drag_0', 'worktree_drag_2'],
      null
    );
    expect(folders.moveWorktree).not.toHaveBeenCalled();
  });

  it('uses aged-out neighbors when reordering positioned Ungrouped workspaces', () => {
    const folders = workspaceFolders();
    renderSidebar({
      workspaceFolders: folders,
      workspaceGroups: [
        phase4Group(0, 'a1'),
        phase4Group(1, 'a2'),
        phase4Group(2, 'a3', { createdAt: new Date(2026, 0, 1).toISOString() }),
      ],
    });

    const rows = dom.container.querySelectorAll<HTMLElement>('[data-worktree-id]');
    expect(rows).toHaveLength(2);
    const sourceTitle = rows[0]?.querySelector('button span');
    if (!rows[0] || !rows[1] || !sourceTitle) throw new Error('Rows missing');

    dragRows(sourceTitle, rows[1], 35);

    expect(folders.initializeWorktreePositions).not.toHaveBeenCalled();
    expect(folders.moveWorktree).toHaveBeenCalledTimes(1);
    const [worktreeId, folderId, position] = folders.moveWorktree.mock.calls[0] ?? [];
    expect(worktreeId).toBe('worktree_drag_0');
    expect(folderId).toBeNull();
    if (typeof position !== 'string') throw new Error('Position missing');
    expect(position > 'a2').toBe(true);
    expect(position < 'a3').toBe(true);
  });

  it('places before the first row when dropped on its top half', () => {
    const folders = workspaceFolders();
    renderSidebar({
      sessions: [],
      workspaceFolders: folders,
      workspaceGroups: [phase4Group(0, 'a2'), phase4Group(1, 'a3')],
    });

    const rows = dom.container.querySelectorAll<HTMLElement>('[data-worktree-id]');
    const sourceTitle = rows[1]?.querySelector('button span');
    if (!rows[0] || !rows[1] || !sourceTitle) throw new Error('Rows missing');

    dragRows(sourceTitle, rows[0], 1);

    expect(folders.initializeWorktreePositions).not.toHaveBeenCalled();
    const [worktreeId, folderId, position] = folders.moveWorktree.mock.calls[0] ?? [];
    expect(worktreeId).toBe('worktree_drag_1');
    expect(folderId).toBeNull();
    expect((position as string) < 'a2').toBe(true);
  });

  function manualFolder(groups: NonNullable<ChatSidebarProps['workspaceGroups']>): WorkspaceFolder {
    return {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      name: 'Product',
      color: 'default',
      kind: 'manual',
      smartPreset: null,
      sortMode: 'activity',
      worktreeIds: groups.map(group => group.worktreeId),
      manualWorktreeOrder: [],
    };
  }

  function fileGroups(groups: NonNullable<ChatSidebarProps['workspaceGroups']>, folderId: string) {
    return groups.map(group => ({ ...group, details: { ...group.details!, folderId } }));
  }

  function workspaceIds(): (string | null)[] {
    return [...dom.container.querySelectorAll('[data-worktree-id]')].map(row =>
      row.getAttribute('data-worktree-id')
    );
  }

  it.each(['manual', 'created', 'activity'] as const)(
    'uses the global %s setting for smart folders, not their saved sort mode',
    workspaceOrder => {
      const folders = workspaceFolders();
      const groups = [
        phase4Group(0, 'a2', {
          createdAt: '2026-01-01T00:00:00.000Z',
          lastActivityAt: '2026-03-01T00:00:00.000Z',
          updatedAt: '2026-03-01T00:00:00.000Z',
          sessionStatus: 'question',
        }),
        phase4Group(1, 'a1', {
          createdAt: '2026-02-01T00:00:00.000Z',
          lastActivityAt: '2026-02-01T00:00:00.000Z',
          updatedAt: '2026-02-01T00:00:00.000Z',
          sessionStatus: 'question',
        }),
      ];
      folders.folders = [
        {
          ...manualFolder([]),
          name: 'Needs you',
          kind: 'smart',
          smartPreset: 'needs_you',
          sortMode: 'created',
          manualWorktreeOrder: ['worktree_drag_1', 'worktree_drag_0'],
        },
      ];
      renderSidebar({ workspaceGroups: groups, workspaceFolders: folders, workspaceOrder });
      expect(workspaceIds()).toEqual(
        workspaceOrder === 'activity'
          ? ['worktree_drag_0', 'worktree_drag_1']
          : ['worktree_drag_1', 'worktree_drag_0']
      );
    }
  );

  it.each(['needs_you', 'in_review', 'done'] as const)(
    'reorders within the %s smart folder without moving or repositioning its workspaces',
    preset => {
      const folders = workspaceFolders();
      const groups = [phase4Group(0, 'a1'), phase4Group(1, 'a2')].map(group => {
        const session = {
          ...group.latestSession,
          sessionStatus: preset === 'needs_you' ? 'question' : 'idle',
          associatedPr:
            preset === 'needs_you'
              ? null
              : {
                  url: 'https://github.com/example/repo/pull/1',
                  number: 1,
                  state: preset === 'done' ? 'merged' : 'open',
                  title: null,
                  headSha: null,
                  observations: null,
                  lastSyncedAt: group.latestSession.createdAt,
                  reviewDecision: null,
                  reviewDecisionPending: false,
                  platform: 'github',
                },
        };
        return {
          ...group,
          latestSession: session,
          sessions: [session],
          details: { ...group.details!, prSession: session },
        };
      });
      const folder: WorkspaceFolder = {
        ...manualFolder([]),
        kind: 'smart',
        smartPreset: preset,
        manualWorktreeOrder: groups.map(group => group.worktreeId),
      };
      folders.folders = [folder];
      renderSidebar({ workspaceGroups: groups, workspaceFolders: folders });
      const rows = dom.container.querySelectorAll<HTMLElement>('[data-worktree-id]');
      const source = rows[0]?.querySelector('button span');
      if (!source || !rows[1]) throw new Error('Rows missing');
      dragRows(source, rows[1], 35);
      expect(folders.reorderSmartFolderWorktrees).toHaveBeenCalledWith(folder.id, [
        groups[1].worktreeId,
        groups[0].worktreeId,
      ]);
      expect(folders.moveWorktree).not.toHaveBeenCalled();
      expect(folders.initializeWorktreePositions).not.toHaveBeenCalled();
    }
  );

  it('puts an existing positioned workspace on top when it enters a smart folder', () => {
    const folders = workspaceFolders();
    const groups = [
      phase4Group(0, 'a1', { sessionStatus: 'question' }),
      phase4Group(1, 'z', { sessionStatus: 'idle' }),
    ];
    folders.folders = [
      {
        ...manualFolder([]),
        kind: 'smart',
        smartPreset: 'needs_you',
        manualWorktreeOrder: [groups[0].worktreeId],
      },
    ];
    renderSidebar({ workspaceGroups: groups, workspaceFolders: folders });
    const nextSession = { ...groups[1].latestSession, sessionStatus: 'question' };
    renderSidebar({
      workspaceGroups: [
        groups[0],
        { ...groups[1], latestSession: nextSession, sessions: [nextSession] },
      ],
      workspaceFolders: folders,
    });
    const section = dom.container.querySelector('[data-folder-id]');
    expect(
      [...section!.querySelectorAll('[data-worktree-id]')].map(row =>
        row.getAttribute('data-worktree-id')
      )
    ).toEqual([groups[1].worktreeId, groups[0].worktreeId]);
  });

  it.each([false, true])(
    'explains an empty smart folder when workspace truncation is %s',
    workspaceRowsTruncated => {
      const folders = workspaceFolders();
      folders.folders = [
        {
          ...manualFolder([]),
          name: 'Done',
          kind: 'smart',
          smartPreset: 'done',
        },
      ];
      renderSidebar({ workspaceGroups: [], workspaceFolders: folders, workspaceRowsTruncated });
      const section = dom.container.querySelector('[aria-label="Folder Done"]');
      expect(section?.textContent).toContain(
        workspaceRowsTruncated
          ? 'Workspace list limited to 200. Use search to find matching workspaces.'
          : 'No matching workspaces. Workspaces appear here automatically.'
      );
      if (workspaceRowsTruncated) {
        expect(section?.textContent).not.toContain('No matching workspaces');
        expect(section?.textContent).not.toContain('Workspaces appear here automatically.');
      }
      expect(section?.textContent).not.toContain('Drop workspaces here');
      expect(section?.textContent).not.toContain('Sort workspaces');
    }
  );

  it('renders saved manual folder positions after a drag, refetch and remount', () => {
    const folders = workspaceFolders();
    const initial = [phase4Group(0, null), phase4Group(1, null), phase4Group(2, null)];
    const folder = manualFolder(initial);
    folders.folders = [folder];
    let groups = fileGroups(initial, folder.id);
    const props = () => ({
      workspaceGroups: groups,
      workspaceFolders: folders,
      workspaceOrder: 'manual' as const,
    });
    renderSidebar(props());
    expect(workspaceIds()).toEqual(initial.map(group => group.worktreeId));

    folders.initializeWorktreePositions.mockImplementation(async ids => {
      groups = groups.map(group => ({
        ...group,
        details: { ...group.details!, sidebarPosition: `a${ids.indexOf(group.worktreeId) + 1}` },
      }));
      return true;
    });
    const rows = dom.container.querySelectorAll<HTMLElement>('[data-worktree-id]');
    dragRows(rows[0]!, rows[1]!, 35, () => {
      expect(rows[1]?.classList.contains('border-b-2')).toBe(true);
    });
    const expected = ['worktree_drag_1', 'worktree_drag_0', 'worktree_drag_2'];
    expect(folders.initializeWorktreePositions).toHaveBeenCalledWith(expected, folder.id);
    renderSidebar(props());
    expect(workspaceIds()).toEqual(expected);
    expect(dom.container.textContent).not.toContain('Sort workspaces');

    act(() => root.unmount());
    root = createRoot(dom.container);
    renderSidebar(props());
    expect(workspaceIds()).toEqual(expected);
  });

  it.each(['created', 'activity'] as const)(
    'does not advertise or save row reordering in %s mode, inside or outside a folder',
    workspaceOrder => {
      const folders = workspaceFolders();
      const groups = [phase4Group(0, 'a2'), phase4Group(1, 'a1')];
      const folder = { ...manualFolder(groups), sortMode: 'manual' as const };
      for (const filed of [false, true]) {
        folders.folders = filed ? [folder] : [];
        renderSidebar({
          workspaceGroups: filed ? fileGroups(groups, folder.id) : groups,
          workspaceFolders: folders,
          workspaceOrder,
        });
        expect(workspaceIds()).toEqual(['worktree_drag_0', 'worktree_drag_1']);
        const rows = dom.container.querySelectorAll<HTMLElement>('[data-worktree-id]');
        expect(rows[0]?.getAttribute('draggable')).toBe('true');
        dragRows(rows[0]!, rows[1]!, 35, () => {
          expect(dom.container.querySelector('[data-worktree-id].border-b-2')).toBeNull();
          expect(dom.container.querySelector('[data-worktree-id].border-t-2')).toBeNull();
        });
        expect(folders.moveWorktree).not.toHaveBeenCalled();
        expect(folders.initializeWorktreePositions).not.toHaveBeenCalled();
      }
    }
  );

  it.each(['manual', 'created', 'activity'] as const)(
    'moves between folders without assigning a row position in %s mode',
    workspaceOrder => {
      const folders = workspaceFolders();
      const groups = [phase4Group(0, 'a1'), phase4Group(1, 'a2')];
      const first = manualFolder([groups[0]!]);
      const second = { ...manualFolder([groups[1]!]), id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
      folders.folders = [first, second];
      renderSidebar({
        workspaceGroups: [
          ...fileGroups([groups[0]!], first.id),
          ...fileGroups([groups[1]!], second.id),
        ],
        workspaceFolders: folders,
        workspaceOrder,
      });
      const rows = dom.container.querySelectorAll<HTMLElement>('[data-worktree-id]');
      dragRows(rows[0]!, rows[1]!, 35, () => {
        expect(dom.container.querySelector('[data-worktree-id].border-b-2')).toBeNull();
      });
      expect(folders.moveWorktree).toHaveBeenCalledWith(groups[0]?.worktreeId, second.id);
      expect(folders.initializeWorktreePositions).not.toHaveBeenCalled();
    }
  );

  it('reorders automatically grouped rows without changing their underlying manual folder', () => {
    const folders = workspaceFolders();
    const groups = [phase4Group(0, 'a1'), phase4Group(1, 'a2')].map(group => ({
      ...group,
      sessions: group.sessions.map(session => ({ ...session, sessionStatus: 'question' })),
    }));
    const folder = manualFolder(groups);
    folders.folders = [folder, { ...folder, id: 'needs', kind: 'smart', smartPreset: 'needs_you' }];
    renderSidebar({ workspaceGroups: fileGroups(groups, folder.id), workspaceFolders: folders });
    const rows = dom.container.querySelectorAll<HTMLElement>('[data-worktree-id]');
    dragRows(rows[0]!, rows[1]!, 35, () => {
      expect(dom.container.querySelector('[data-worktree-id].border-b-2')).not.toBeNull();
    });
    expect(folders.reorderSmartFolderWorktrees).toHaveBeenCalledWith('needs', [
      groups[1].worktreeId,
      groups[0].worktreeId,
    ]);
    expect(folders.moveWorktree).not.toHaveBeenCalled();
    expect(folders.initializeWorktreePositions).not.toHaveBeenCalled();
  });
});

describe('ChatSidebar stacked workspace preflight', () => {
  let dom: ReturnType<typeof installDom>;
  let root: Root;

  beforeAll(() => {
    dom = installDom();
  });

  afterAll(() => dom.cleanup());

  beforeEach(() => {
    mockPathname = '/cloud';
    mockStackedSource = { source: undefined, isPending: false };
    root = createRoot(dom.container);
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  function renderSidebar(): void {
    const session = makeSession(0, {
      worktreeId: 'worktree_root',
      repository: 'kilo/repo',
      branch: 'feature/base',
    });
    const group = {
      type: 'worktree' as const,
      worktreeId: 'worktree_root',
      sessions: [session],
      latestSession: session,
      details: {
        name: 'Root workspace',
        defaultTitle: null,
        branch: 'feature/base',
        parentWorktreeId: null,
        baseBranch: null,
        prSession: null,
        sessions: [session],
      },
    };
    act(() => {
      root.render(
        React.createElement(
          ChatSidebar,
          baseProps({
            sessions: [],
            workspaceGroups: [group],
          })
        )
      );
    });
  }

  it('disables the menu item and explains the exact push requirement when the branch is unpushed', () => {
    mockStackedSource = {
      source: { branch: 'feature/base', repository: 'kilo/repo', basePushed: false },
      isPending: false,
    };
    renderSidebar();

    const item = dom.container.querySelector<HTMLElement>(
      '[role="menuitem"]:has(svg.lucide-layers)'
    );
    if (!item) throw new Error('Stacked workspace menu item missing');
    expect(
      item.getAttribute('aria-disabled') ?? item.closest('[aria-disabled="true"]')
    ).toBeTruthy();
    expect(dom.container.textContent).toContain(
      'Push `feature/base` first; it will be pushed after the next successful turn, or enable auto-commit'
    );
  });
});

describe('ChatSidebar phase 4 drag ordering end placement', () => {
  let dom: ReturnType<typeof installDom>;
  let root: Root;

  beforeAll(() => {
    dom = installDom();
  });

  afterAll(() => dom.cleanup());

  beforeEach(() => {
    mockPathname = '/cloud';
    mockStackedSource = { source: undefined, isPending: false };
    root = createRoot(dom.container);
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it('appends after the last row when dropped on its bottom half', () => {
    const session = (index: number, position: string) => {
      const value = makeSession(index, {
        worktreeId: `worktree_drag_${index}`,
        cloudAgentSessionId: `workspace_${index}`,
      });
      return {
        type: 'worktree' as const,
        worktreeId: value.worktreeId!,
        sessions: [value],
        latestSession: value,
        details: {
          name: `Workspace ${index}`,
          defaultTitle: null,
          branch: `feature/${index}`,
          parentWorktreeId: null,
          baseBranch: null,
          folderId: null,
          sidebarPosition: position,
          createdAt: value.createdAt,
          prSession: null,
          sessions: [value],
        },
      };
    };
    const folders = {
      folders: [],
      isLoading: false,
      isFirstLoadPending: false,
      isError: false,
      isSaving: false,
      collapsedFolderIds: [] as string[],
      toggleFolder: jest.fn(),
      saveFolder: jest.fn(async () => true),
      setFolderColor: jest.fn(async () => true),
      deleteFolder: jest.fn(async () => true),
      moveWorktree: jest.fn(
        async (_worktreeId: string, _folderId: string | null, _position?: string | null) => false
      ),
      moveSession: jest.fn(async () => false),
      initializeWorktreePositions: jest.fn(
        async (_orderedWorktreeIds: readonly string[], _folderId: string | null) => true
      ),
      reorderFolders: jest.fn(async () => true),
      reorderSmartFolderWorktrees: jest.fn(async () => true),
      refresh: jest.fn(async () => undefined),
    } satisfies NonNullable<ChatSidebarProps['workspaceFolders']>;

    act(() => {
      root.render(
        React.createElement(
          ChatSidebar,
          baseProps({
            sessions: [],
            workspaceFolders: folders,
            workspaceGroups: [session(0, 'a1'), session(1, 'a2')],
          })
        )
      );
    });

    const rows = dom.container.querySelectorAll<HTMLElement>('[data-worktree-id]');
    const sourceTitle = rows[0]?.querySelector('button span');
    if (!rows[0] || !rows[1] || !sourceTitle) throw new Error('Rows missing');

    const dataTransfer = {
      setData: jest.fn(),
      setDragImage: jest.fn(),
      effectAllowed: '',
      dropEffect: '',
    };
    const dispatch = (element: Element, type: string, y: number) => {
      const event = new window.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        dataTransfer: { value: dataTransfer },
        clientX: { value: 30 },
        clientY: { value: y },
      });
      act(() => {
        element.dispatchEvent(event);
      });
    };
    rows[1]!.getBoundingClientRect = () =>
      ({ top: 0, left: 0, width: 200, height: 40, bottom: 40, right: 200, x: 0, y: 0 }) as DOMRect;
    dispatch(sourceTitle, 'dragstart', 0);
    dispatch(rows[1]!, 'dragover', 35);
    dispatch(rows[1]!, 'drop', 35);

    expect(folders.initializeWorktreePositions).not.toHaveBeenCalled();
    const [worktreeId, folderId, position] = folders.moveWorktree.mock.calls[0] ?? [];
    expect(worktreeId).toBe('worktree_drag_0');
    expect(folderId).toBeNull();
    expect((position as string) > 'a2').toBe(true);
  });
});
