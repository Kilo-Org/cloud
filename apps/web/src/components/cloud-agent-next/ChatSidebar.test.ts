import React, { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createRequire } from 'node:module';
import type { StoredSession } from './types';

Object.assign(globalThis, { React });

let mockPathname = '/cloud';
const mockRouterPush = jest.fn();
const mockRouter = { push: mockRouterPush };

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
    Tooltip: passthrough,
    TooltipTrigger: passthrough,
    TooltipContent: passthrough,
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
    }: {
      children?: ReactNode;
      onClick?: (event: React.MouseEvent) => void;
    }) => react.createElement('div', { role: 'menuitem', onClick }, children),
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

type ChatSidebarProps = React.ComponentProps<typeof ChatSidebar>;

const SESSION_COUNT = 200;
const indicatorMock = jest.mocked(SessionPrIndicator);

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

function activeSession(session: StoredSession, status = 'idle') {
  return {
    id: session.sessionId,
    status,
    title: session.prompt,
    connectionId: 'test-connection',
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
    mockRouterPush.mockClear();
    indicatorMock.mockClear();
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
    'renders a hidden %s sibling on its worktree during search',
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
        activeSessions: [activeSession(hidden)],
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
      expect(row?.querySelector(`[role="img"][aria-label="${label}"]`)).not.toBeNull();
      expect(row?.querySelector('[data-time-ago]')).toBeNull();
      expect(row?.textContent).not.toContain(hidden.prompt);
      expect(dom.container.querySelector(`[data-session-pr="${hidden.sessionId}"]`)).toBeNull();

      renderSidebar({
        ...props,
        worktreeDetails: {
          worktree_shared: {
            ...props.worktreeDetails.worktree_shared,
            sessions: [visible, { ...hidden, latestRunFailureKind: null }],
          },
        },
      });
      expect(dom.container.querySelector(`[aria-label="${label}"]`)).toBeNull();
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
        { id: ids[0], name: 'Product', color: 'blue' as const, worktreeIds: [] as string[] },
      ],
      isLoading: false,
      isError: false,
      isSaving: false,
      collapsedFolderIds: [],
      toggleFolder: jest.fn(),
      saveFolder: jest.fn(async () => true),
      setFolderColor: jest.fn(async () => true),
      deleteFolder: jest.fn(async () => true),
      moveWorktree: jest.fn(async () => false),
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

  it('keeps immutable standalone rows flat when live inputs churn with stable callbacks', () => {
    const sessions = makeSessions(SESSION_COUNT);
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
