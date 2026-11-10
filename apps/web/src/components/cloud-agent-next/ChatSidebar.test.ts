import React, { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createRequire } from 'node:module';
import type { StoredSession } from './types';

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
    DropdownMenuRadioItem: passthrough,
    DropdownMenuSub: passthrough,
    DropdownMenuSubTrigger: passthrough,
    DropdownMenuSubContent: passthrough,
    DropdownMenuPortal: passthrough,
    DropdownMenuGroup: passthrough,
    DropdownMenuShortcut: passthrough,
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

  it('keeps one skeleton until sessions, names and folders are ready together', () => {
    const session = makeSession(0, { worktreeId: 'worktree_ready' });
    renderSidebar({ sessions: [session], isLoading: true });
    expect(dom.container.querySelector('[aria-label="Loading sessions"]')).not.toBeNull();
    expect(dom.container.querySelector('[data-worktree-id="worktree_ready"]')).toBeNull();

    renderSidebar({ sessions: [session] });
    expect(dom.container.querySelector('[aria-label="Loading sessions"]')).toBeNull();
    expect(dom.container.querySelector('[data-worktree-id="worktree_ready"]')).not.toBeNull();
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
      setFolderSortMode: jest.fn(async () => true),
      deleteFolder: jest.fn(async () => true),
      moveWorktree: jest.fn(
        async (_worktreeId: string, _folderId: string | null, _position?: string | null) => false
      ),
      moveSession: jest.fn(async () => false),
      initializeWorktreePositions: jest.fn(
        async (_orderedWorktreeIds: readonly string[], _folderId: string | null) => true
      ),
      reorderFolders: jest.fn(async () => true),
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
    sidebarPosition: string | null
  ): NonNullable<ChatSidebarProps['workspaceGroups']>[number] {
    const session = makeSession(index, {
      worktreeId: `worktree_drag_${index}`,
      cloudAgentSessionId: `workspace_${index}`,
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
      folders: [],
      isLoading: false,
      isFirstLoadPending: false,
      isError: false,
      isSaving: false,
      collapsedFolderIds: [] as string[],
      toggleFolder: jest.fn(),
      saveFolder: jest.fn(async () => true),
      setFolderColor: jest.fn(async () => true),
      setFolderSortMode: jest.fn(async () => true),
      deleteFolder: jest.fn(async () => true),
      moveWorktree: jest.fn(
        async (_worktreeId: string, _folderId: string | null, _position?: string | null) => false
      ),
      moveSession: jest.fn(async () => false),
      initializeWorktreePositions: jest.fn(
        async (_orderedWorktreeIds: readonly string[], _folderId: string | null) => true
      ),
      reorderFolders: jest.fn(async () => true),
      refresh: jest.fn(async () => undefined),
    } satisfies NonNullable<ChatSidebarProps['workspaceFolders']>;
  }

  function dragRows(
    source: Element,
    target: Element,
    clientY: number
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
    event(target, 'drop', clientY);
    return { dataTransfer };
  }

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
      setFolderSortMode: jest.fn(async () => true),
      deleteFolder: jest.fn(async () => true),
      moveWorktree: jest.fn(
        async (_worktreeId: string, _folderId: string | null, _position?: string | null) => false
      ),
      moveSession: jest.fn(async () => false),
      initializeWorktreePositions: jest.fn(
        async (_orderedWorktreeIds: readonly string[], _folderId: string | null) => true
      ),
      reorderFolders: jest.fn(async () => true),
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
