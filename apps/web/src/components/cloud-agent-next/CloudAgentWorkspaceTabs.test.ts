import { describe, expect, it } from '@jest/globals';
import React, { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button } from '@/components/ui/button';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import type * as DropdownMenuComponents from '@/components/ui/dropdown-menu';
import type * as DropdownMenuPrimitives from '@radix-ui/react-dropdown-menu';
import { CloudAgentWorkspaceTabs } from './CloudAgentWorkspaceTabs';
import { CHAT_TAB_ID, fileTabId, terminalTabId, type WorkspaceTabId } from './workspace-tabs';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import type { StoredSession } from './types';

Object.assign(globalThis, { React });

let mockRenderOpenMenus = false;

jest.mock('@/components/ui/button', () => {
  const actual = jest.requireActual<{ Button: typeof Button }>('@/components/ui/button');
  return { ...actual, Button: jest.fn(actual.Button) };
});

jest.mock('@/components/ui/dropdown-menu', () => {
  const actual = jest.requireActual<typeof DropdownMenuComponents>('@/components/ui/dropdown-menu');
  const primitives = jest.requireActual<typeof DropdownMenuPrimitives>(
    '@radix-ui/react-dropdown-menu'
  );
  const { createElement } = jest.requireActual<typeof React>('react');

  return {
    ...actual,
    DropdownMenu: (props: ComponentProps<typeof actual.DropdownMenu>) =>
      createElement(actual.DropdownMenu, { ...props, defaultOpen: mockRenderOpenMenus }),
    DropdownMenuContent: (props: ComponentProps<typeof actual.DropdownMenuContent>) =>
      createElement(primitives.Content, props),
    DropdownMenuItem: jest.fn(actual.DropdownMenuItem),
  };
});

type WorkspaceTabsProps = ComponentProps<typeof CloudAgentWorkspaceTabs>;

function makeSession(
  sessionId: string,
  title: string,
  overrides: Partial<StoredSession> = {}
): StoredSession {
  return {
    sessionId,
    repository: 'kilo/repository',
    prompt: title,
    mode: 'code',
    model: 'test-model',
    status: 'active',
    createdAt: '2026-08-26T10:00:00.000Z',
    updatedAt: '2026-08-26T10:00:00.000Z',
    messages: [],
    cloudAgentSessionId: `agent_${sessionId}`,
    worktreeId: 'worktree_shared',
    ...overrides,
  };
}

function renderWorkspaceTabs(
  overrides: Partial<WorkspaceTabsProps> = {},
  openMenus = false
): string {
  mockRenderOpenMenus = openMenus;
  jest.mocked(Button).mockClear();
  jest.mocked(DropdownMenuItem).mockClear();
  const session = makeSession('ses_first', 'First worktree chat');
  const props: WorkspaceTabsProps = {
    activeTabId: CHAT_TAB_ID,
    chatSessions: [session],
    currentSessionId: session.sessionId,
    onSelectChat: () => undefined,
    onCloseChat: () => undefined,
    onCreateChat: () => undefined,
    onRenameChat: async () => undefined,
    terminals: [],
    files: [],
    onCloseFile: () => undefined,
    terminalStatuses: {},
    canCreateTerminal: false,
    onSelectTab: () => undefined,
    onCreateTerminal: () => undefined,
    onCloseTerminal: () => undefined,
    ...overrides,
  };

  const worktreeId =
    props.worktreeId === undefined
      ? props.chatSessions.find(chat => chat.sessionId === props.currentSessionId)?.worktreeId
      : props.worktreeId;
  const value =
    props.activeTabId === CHAT_TAB_ID && worktreeId && props.currentSessionId
      ? `chat:${props.currentSessionId}`
      : props.activeTabId;
  return renderToStaticMarkup(
    createElement(
      Tabs,
      { value },
      createElement(CloudAgentWorkspaceTabs, props),
      createElement(TabsContent, { value }, 'Selected workspace panel')
    )
  );
}

function findButtonMarkup(html: string, text: string): string {
  const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
  const button = buttons.find(markup => markup.includes(text));
  expect(button).toBeDefined();
  return button ?? '';
}

function findMenuItemMarkup(html: string, text: string): string {
  const items = html.match(/<div\b[^>]*role="menuitem"[^>]*>[\s\S]*?<\/div>/g) ?? [];
  const item = items.find(markup => markup.includes(text));
  expect(item).toBeDefined();
  return item ?? '';
}

function getButtonProps(label: string): ComponentProps<typeof Button> {
  const props = jest
    .mocked(Button)
    .mock.calls.find(([props]) => props['aria-label'] === label)?.[0];
  if (!props) throw new Error(`Button not rendered: ${label}`);
  return props;
}

function getSessionMenuItemProps(title: string): ComponentProps<typeof DropdownMenuItem> {
  const props = jest
    .mocked(DropdownMenuItem)
    .mock.calls.find(([props]) => props.textValue === title)?.[0];
  if (!props) throw new Error(`Session menu item not rendered: ${title}`);
  return props;
}

describe('CloudAgentWorkspaceTabs', () => {
  it('composes selected file and sibling chat values with their shared Radix panels', () => {
    for (const activeTabId of [CHAT_TAB_ID, fileTabId('src/file.ts')] as const) {
      const html = renderWorkspaceTabs({
        activeTabId,
        files: [{ path: 'src/file.ts' }],
        worktreeId: 'worktree_shared',
      });
      const active = (html.match(/<button\b[^>]*>/g) ?? []).filter(
        button => button.includes('role="tab"') && button.includes('data-state="active"')
      );
      expect(active).toHaveLength(1);
      const controls = active[0]?.match(/aria-controls="([^"]+)"/)?.[1];
      expect(controls).toBeDefined();
      expect(html).toContain(`id="${controls}"`);
      expect(html).toContain('Selected workspace panel');
    }
  });
  it('renders complete grouped chat titles and selects only the current session tab', () => {
    const firstTitle = 'Investigate the complete authentication regression across every provider';
    const secondTitle = 'Fix the separate billing synchronization flow';
    const first = makeSession('ses_first', firstTitle, {
      associatedPr: {
        url: 'https://github.com/kilo/repository/pull/42',
        number: 42,
        state: 'open',
        title: 'Authentication fix',
        headSha: 'abc123',
        lastSyncedAt: '2026-08-26T10:00:00.000Z',
        reviewDecision: null,
        reviewDecisionPending: false,
        platform: 'github',
      },
    });
    const second = makeSession('ses_second', secondTitle, { branch: 'feature/billing' });
    const html = renderWorkspaceTabs({
      chatSessions: [first, second],
      currentSessionId: second.sessionId,
    });

    const firstChatTrigger = findButtonMarkup(html, firstTitle);

    expect(html).toContain('role="tablist"');
    expect(html).toContain(firstTitle);
    expect(html).toContain(secondTitle);
    expect(firstChatTrigger).toContain('aria-selected="false"');
    expect(firstChatTrigger).toContain('data-state="inactive"');
    expect(findButtonMarkup(html, secondTitle)).toContain('aria-selected="true"');
    expect(findButtonMarkup(html, secondTitle)).toContain('data-state="active"');
    expect(html).toContain('aria-label="open pull request #42"');
    expect(html).not.toContain('animate-pulse');
    expect(firstChatTrigger).not.toContain('aria-label="open pull request #42"');
    expect(html).not.toMatch(/<button\b[^>]*>(?:(?!<\/button>)[\s\S])*<button\b/);
    expect(html).not.toContain('Session actions for');
    expect(html).not.toContain('lucide-ellipsis');
    expect(html).not.toContain('lucide-more-horizontal');
    expect(html).not.toContain('aria-label="Sessions"');
    expect(html).toContain(`aria-label="Close ${firstTitle}"`);
    expect(firstChatTrigger).not.toContain(`aria-label="Close ${firstTitle}"`);
  });

  it('honors the provided open-tab order regardless of grouped order and filters unknown or foreign IDs', () => {
    const first = makeSession('ses_first', 'First chat');
    const second = makeSession('ses_second', 'Second chat');
    const third = makeSession('ses_third', 'Third chat');
    const foreign = makeSession('ses_foreign', 'Foreign chat', { worktreeId: 'worktree_other' });

    for (const chatSessions of [
      [first, second, third, foreign],
      [second, foreign, third, first],
    ]) {
      const html = renderWorkspaceTabs({
        chatSessions,
        currentSessionId: first.sessionId,
        openChatSessionIds: [
          third.sessionId,
          'ses_unknown',
          first.sessionId,
          foreign.sessionId,
          second.sessionId,
        ],
      });

      expect(html.indexOf(findButtonMarkup(html, third.prompt))).toBeLessThan(
        html.indexOf(findButtonMarkup(html, first.prompt))
      );
      expect(html.indexOf(findButtonMarkup(html, first.prompt))).toBeLessThan(
        html.indexOf(findButtonMarkup(html, second.prompt))
      );
      expect(html).not.toContain('ses_unknown');
      expect(html).not.toContain(foreign.prompt);
    }
  });

  it('renders existing shared busy and attention indicators for different chats', () => {
    const busy = makeSession('ses_busy', 'Running investigation', { sessionStatus: 'busy' });
    const attention = makeSession('ses_attention', 'Waiting on an answer', {
      sessionStatus: 'question',
    });
    const html = renderWorkspaceTabs({
      chatSessions: [busy, attention],
      currentSessionId: busy.sessionId,
    });

    expect(findButtonMarkup(html, busy.prompt)).toContain('<title>Busy</title>');
    expect(findButtonMarkup(html, attention.prompt)).toContain('aria-label="Waiting for answer"');
  });

  it('keeps the split chat action busy and disables only chat creation while pending', () => {
    const html = renderWorkspaceTabs({ isCreatingChat: true, canCreateTerminal: true }, true);
    const action = findButtonMarkup(html, 'aria-label="New chat"');
    const options = findButtonMarkup(html, 'aria-label="Tab options"');

    expect(action).toContain('disabled=""');
    expect(action).toContain('aria-busy="true"');
    expect(action).toContain('animate-spin');
    expect(action).not.toContain('role="tab"');
    expect(options).toContain('aria-haspopup="menu"');
    expect(options).not.toContain('disabled=""');
    expect(findMenuItemMarkup(html, 'New chat')).toContain('aria-disabled="true"');
    expect(findMenuItemMarkup(html, 'New terminal')).not.toContain('aria-disabled="true"');
  });

  it('creates chat from the labeled plus action and exposes terminal creation only in the menu', () => {
    let createdChats = 0;
    const html = renderWorkspaceTabs(
      { canCreateTerminal: true, onCreateChat: () => createdChats++ },
      true
    );

    expect(findButtonMarkup(html, 'aria-label="New chat"')).toContain('lucide-plus');
    expect(findButtonMarkup(html, 'aria-label="Tab options"')).toContain('lucide-chevron-down');
    expect(html).not.toContain('aria-label="New terminal"');
    expect(findMenuItemMarkup(html, 'New chat')).not.toContain('aria-disabled="true"');
    expect(findMenuItemMarkup(html, 'New terminal')).not.toContain('aria-disabled="true"');
    getButtonProps('New chat').onClick?.({} as React.MouseEvent<HTMLButtonElement>);
    expect(createdChats).toBe(1);
  });

  it('does not expose terminal creation without the terminal capability', () => {
    const html = renderWorkspaceTabs({ canCreateTerminal: false }, true);

    expect(html).toContain('aria-label="New chat"');
    expect(html).not.toContain('New terminal');
  });

  it('offers eligible terminal creation and history in the caret without chat creation', () => {
    const html = renderWorkspaceTabs(
      { onCreateChat: undefined, canCreateTerminal: true, isCreatingChat: true },
      true
    );

    expect(findButtonMarkup(html, 'aria-label="Tab options"')).not.toContain('disabled=""');
    expect(findMenuItemMarkup(html, 'New terminal')).not.toContain('aria-disabled="true"');
    expect(html).toContain('>Sessions<');
    expect(html).not.toContain('New chat');
    expect(html).not.toContain('aria-label="New terminal"');
    expect(html).not.toContain('aria-label="Sessions"');
    expect(html.match(/aria-haspopup="menu"/g)).toHaveLength(1);
  });

  it('lists only closed worktree sessions below creation actions in the caret menu', () => {
    const current = makeSession('ses_current', 'Current chat');
    const open = makeSession('ses_open', 'Another open chat');
    const closed = makeSession(
      'ses_closed',
      'A complete archived investigation title that remains readable when its tab is closed',
      { sessionStatus: 'permission' }
    );
    const unrelated = makeSession('ses_other', 'A different worktree', {
      worktreeId: 'worktree_other',
    });
    const props = {
      chatSessions: [current, open, closed, unrelated],
      currentSessionId: current.sessionId,
      openChatSessionIds: [current.sessionId, open.sessionId, unrelated.sessionId],
      canCreateTerminal: true,
    };
    const tabsHtml = renderWorkspaceTabs(props);

    expect(tabsHtml).toContain(current.prompt);
    expect(tabsHtml).toContain(open.prompt);
    expect(tabsHtml).not.toContain(closed.prompt);
    expect(tabsHtml).not.toContain(unrelated.prompt);
    expect(tabsHtml).not.toContain('aria-label="Sessions"');
    expect(tabsHtml.match(/aria-haspopup="menu"/g)).toHaveLength(1);
    const optionsTrigger = findButtonMarkup(tabsHtml, 'aria-label="Tab options"');
    expect(optionsTrigger).toContain('title="Tab options and Sessions"');
    expect(optionsTrigger).toContain('aria-haspopup="menu"');
    expect(optionsTrigger).not.toContain('role="tab"');

    const historyHtml = renderWorkspaceTabs(props, true);
    const closedItem = findMenuItemMarkup(historyHtml, closed.prompt);
    const sessionsLabelIndex = historyHtml.indexOf('>Sessions<');
    const historyTitles = jest
      .mocked(DropdownMenuItem)
      .mock.calls.map(([props]) => props.textValue)
      .filter(title => title !== undefined);

    expect(historyTitles).toEqual([closed.prompt]);
    expect(sessionsLabelIndex).toBeGreaterThan(0);
    expect(historyHtml.indexOf(findMenuItemMarkup(historyHtml, 'New chat'))).toBeLessThan(
      historyHtml.indexOf(findMenuItemMarkup(historyHtml, 'New terminal'))
    );
    expect(historyHtml.indexOf(findMenuItemMarkup(historyHtml, 'New terminal'))).toBeLessThan(
      sessionsLabelIndex
    );
    expect(sessionsLabelIndex).toBeLessThan(historyHtml.indexOf(closedItem));
    expect(closedItem).toContain('Closed tab');
    expect(closedItem).toContain('aria-label="Waiting for permission"');
    expect(closedItem).not.toContain('truncate');
    expect(historyHtml).not.toContain('Current tab');
    expect(historyHtml).not.toContain('Open tab');
    expect(historyHtml).not.toContain(unrelated.prompt);
  });

  it('uses the supplied closed-session order without exposing open or foreign chats', () => {
    const first = makeSession('ses_first', 'First chat');
    const second = makeSession('ses_second', 'Second chat');
    const third = makeSession('ses_third', 'Third chat');
    renderWorkspaceTabs(
      {
        chatSessions: [first, second, third],
        currentSessionId: second.sessionId,
        openChatSessionIds: [second.sessionId],
        closedChatSessionIds: [third.sessionId, 'ses_unknown', second.sessionId, first.sessionId],
      },
      true
    );

    const historyTitles = jest
      .mocked(DropdownMenuItem)
      .mock.calls.map(([props]) => props.textValue)
      .filter(title => title !== undefined);
    expect(historyTitles).toEqual([third.prompt, first.prompt]);
  });

  it('preserves grouped order and treats every grouped session as open when the list is omitted', () => {
    const first = makeSession('ses_first', 'First chat');
    const second = makeSession('ses_second', 'Second chat');
    const html = renderWorkspaceTabs(
      { chatSessions: [second, first], currentSessionId: first.sessionId },
      true
    );

    expect(findButtonMarkup(html, first.prompt)).toContain('role="tab"');
    expect(findButtonMarkup(html, second.prompt)).toContain('role="tab"');
    expect(html.indexOf(findButtonMarkup(html, second.prompt))).toBeLessThan(
      html.indexOf(findButtonMarkup(html, first.prompt))
    );
    expect(findMenuItemMarkup(html, 'No closed sessions')).toContain('aria-disabled="true"');
    expect(html).not.toContain('Closed tab');
  });

  it('closes a chat non-destructively with no tab action menu or deletion action', () => {
    const closedIds: string[] = [];
    const html = renderWorkspaceTabs({ onCloseChat: sessionId => closedIds.push(sessionId) }, true);
    const closeButton = findButtonMarkup(html, 'aria-label="Close First worktree chat"');

    expect(closeButton).toContain('Close tab. Reopen from Sessions in the tab options menu.');
    expect(closeButton).toContain('lucide-x');
    expect(closeButton).not.toContain('destructive');
    expect(html).not.toContain('Session actions for');
    expect(html).not.toContain('Delete session');
    expect(html).not.toContain('>Rename<');
    getButtonProps('Close First worktree chat').onClick?.(
      {} as React.MouseEvent<HTMLButtonElement>
    );
    expect(closedIds).toEqual(['ses_first']);
  });

  it.each([true, false])(
    'retains caret history after the final chat closes with chat creation=%s',
    canCreateChat => {
      const closed = makeSession('ses_closed', 'Closed worktree chat');
      const props = {
        worktreeId: 'worktree_shared',
        currentSessionId: null,
        chatSessions: [closed],
        openChatSessionIds: [],
        onCreateChat: canCreateChat ? () => undefined : undefined,
      };
      const tabsHtml = renderWorkspaceTabs(props);

      expect(tabsHtml).not.toContain('role="tab"');
      expect(tabsHtml).not.toContain(closed.prompt);
      expect(tabsHtml.includes('aria-label="New chat"')).toBe(canCreateChat);
      expect(tabsHtml).not.toContain('aria-label="Sessions"');
      const optionsTrigger = findButtonMarkup(tabsHtml, 'aria-label="Tab options"');
      expect(optionsTrigger).toContain('aria-haspopup="menu"');
      expect(optionsTrigger).not.toContain('disabled=""');
      expect(findMenuItemMarkup(renderWorkspaceTabs(props, true), closed.prompt)).toContain(
        'Closed tab'
      );
    }
  );

  it('keeps an empty selected worktree scoped instead of rendering a generic Chat tab', () => {
    const html = renderWorkspaceTabs(
      {
        worktreeId: 'worktree_empty',
        currentSessionId: null,
        chatSessions: [],
        openChatSessionIds: [],
      },
      true
    );

    expect(html).not.toContain('role="tab"');
    expect(html).toContain('aria-label="New chat"');
    expect(findButtonMarkup(html, 'aria-label="Tab options"')).toContain('aria-haspopup="menu"');
    expect(html).not.toContain('aria-label="Sessions"');
    expect(findMenuItemMarkup(html, 'No closed sessions')).toContain('aria-disabled="true"');
  });

  it('uses the explicitly selected worktree instead of the current session for history', () => {
    const previous = makeSession('ses_previous', 'Previous worktree chat');
    const selected = makeSession('ses_selected', 'Selected worktree chat', {
      worktreeId: 'worktree_selected',
    });
    const html = renderWorkspaceTabs(
      {
        worktreeId: selected.worktreeId,
        chatSessions: [previous, selected],
        currentSessionId: previous.sessionId,
        openChatSessionIds: [],
      },
      true
    );

    expect(html).not.toContain(previous.prompt);
    expect(html).not.toContain('role="tab"');
    expect(findMenuItemMarkup(html, selected.prompt)).toContain('Closed tab');
  });

  it.each([
    { activeTabId: CHAT_TAB_ID, currentSessionId: null },
    { activeTabId: CHAT_TAB_ID, currentSessionId: 'ses_closed' },
    { activeTabId: terminalTabId('terminal_first'), currentSessionId: 'ses_closed' },
  ])('reopens history from $activeTabId with current session $currentSessionId', initial => {
    const closed = makeSession('ses_closed', 'Closed chat');
    let selectedSessionId: string | null = null;
    let selectedTabId: WorkspaceTabId = initial.activeTabId;
    const openedIds: string[] = [];
    renderWorkspaceTabs(
      {
        ...initial,
        worktreeId: 'worktree_shared',
        chatSessions: [closed],
        openChatSessionIds: [],
        onSelectChat: sessionId => {
          selectedSessionId = sessionId;
          openedIds.push(sessionId);
        },
        onSelectTab: tabId => {
          selectedTabId = tabId;
        },
      },
      true
    );

    getSessionMenuItemProps(closed.prompt).onSelect?.(new Event('select'));

    expect(selectedSessionId).toBe(closed.sessionId);
    expect(openedIds).toEqual([closed.sessionId]);
    expect(selectedTabId).toBe(CHAT_TAB_ID);
    const reopenedHtml = renderWorkspaceTabs({
      worktreeId: 'worktree_shared',
      chatSessions: [closed],
      currentSessionId: selectedSessionId,
      openChatSessionIds: openedIds,
      activeTabId: selectedTabId,
    });
    expect(findButtonMarkup(reopenedHtml, closed.prompt)).toContain('aria-selected="true"');
  });

  it('keeps caret history and local close available when mutation permissions are absent', () => {
    const open = makeSession('ses_open', 'Open worktree chat');
    const closed = makeSession('ses_closed', 'Closed worktree chat');
    const html = renderWorkspaceTabs(
      {
        chatSessions: [open, closed],
        currentSessionId: open.sessionId,
        openChatSessionIds: [open.sessionId],
        onCreateChat: undefined,
        onRenameChat: undefined,
        canCreateTerminal: false,
      },
      true
    );

    expect(html).not.toContain('New chat');
    expect(findButtonMarkup(html, 'aria-label="Tab options"')).toContain('aria-haspopup="menu"');
    expect(html).not.toContain('New terminal');
    expect(html).not.toContain('Session actions for');
    expect(html).not.toContain('Delete session');
    expect(html).not.toContain('aria-keyshortcuts="F2"');
    expect(html).not.toContain('Double-click');
    expect(html).toContain(`aria-label="Close ${open.prompt}"`);
    expect(findMenuItemMarkup(html, closed.prompt)).toContain('Closed tab');
    expect(html).not.toContain('Current tab');
    expect(html).not.toContain('Open tab');
  });

  it.each([true, false])(
    'exposes inline rename guidance only with rename capability=%s',
    canRename => {
      const html = renderWorkspaceTabs(
        { onRenameChat: canRename ? async () => undefined : undefined },
        true
      );
      const tab = findButtonMarkup(html, 'First worktree chat');

      expect(tab.includes('aria-keyshortcuts="F2"')).toBe(canRename);
      expect(tab.includes('aria-description="Double-click to rename."')).toBe(canRename);
      expect(html).not.toContain('>Rename<');
      expect(html).not.toContain('Delete session');
      expect(html).not.toContain('Session actions for');
    }
  );

  it('does not offer closing when the optional close callback is absent', () => {
    const html = renderWorkspaceTabs({ onCloseChat: undefined });

    expect(html).not.toContain('aria-label="Close First worktree chat"');
    expect(html).not.toContain('Session actions for');
    expect(findButtonMarkup(html, 'First worktree chat')).toContain('aria-keyshortcuts="F2"');
  });

  it('disables selection, closing, and rename guidance while a session is being deleted', () => {
    const html = renderWorkspaceTabs({ deletingSessionIds: ['ses_first'] }, true);

    expect(findButtonMarkup(html, 'First worktree chat')).toContain('disabled=""');
    expect(findButtonMarkup(html, 'aria-label="Close First worktree chat"')).toContain(
      'disabled=""'
    );
    expect(html).toContain('aria-label="Deleting session"');
    expect(html).not.toContain('aria-keyshortcuts="F2"');
    expect(html).not.toContain('Double-click');
    expect(html).not.toContain('Session actions for');
  });

  it('keeps concurrent deletions disabled without blocking another worktree chat', () => {
    const first = makeSession('ses_first', 'First chat');
    const second = makeSession('ses_second', 'Second chat');
    const remaining = makeSession('ses_remaining', 'Remaining chat');
    const html = renderWorkspaceTabs({
      chatSessions: [first, second, remaining],
      currentSessionId: remaining.sessionId,
      deletingSessionIds: [first.sessionId, second.sessionId],
    });

    for (const session of [first, second]) {
      const tab = findButtonMarkup(html, session.prompt);
      expect(tab).toContain('disabled=""');
      expect(tab).not.toContain('aria-keyshortcuts="F2"');
      expect(findButtonMarkup(html, `aria-label="Close ${session.prompt}"`)).toContain(
        'disabled=""'
      );
    }
    expect(findButtonMarkup(html, remaining.prompt)).not.toContain('disabled=""');
    expect(findButtonMarkup(html, remaining.prompt)).toContain('aria-keyshortcuts="F2"');
    expect(findButtonMarkup(html, `aria-label="Close ${remaining.prompt}"`)).not.toContain(
      'disabled=""'
    );
  });

  it('disables reopening a closed session while it is being deleted', () => {
    const html = renderWorkspaceTabs(
      { deletingSessionIds: ['ses_first'], openChatSessionIds: [] },
      true
    );
    const item = findMenuItemMarkup(html, 'First worktree chat');

    expect(item).toContain('aria-disabled="true"');
    expect(item).toContain('aria-label="Deleting session"');
    expect(item).toContain('Closed tab');
  });

  it('retains the generic Chat tab and hides sibling creation for standalone sessions', () => {
    const standalone = makeSession('ses_standalone', 'Standalone session title', {
      worktreeId: null,
    });
    const html = renderWorkspaceTabs({
      chatSessions: [standalone],
      currentSessionId: standalone.sessionId,
    });

    expect(findButtonMarkup(html, '>Chat<')).toContain('aria-selected="true"');
    expect(html).not.toContain(standalone.prompt);
    expect(html).not.toContain('New chat');
  });

  it('treats an explicit null worktree as standalone even when the session has a worktree', () => {
    const html = renderWorkspaceTabs({ worktreeId: null });

    expect(findButtonMarkup(html, '>Chat<')).toContain('aria-selected="true"');
    expect(html).not.toContain('First worktree chat');
    expect(html).not.toContain('New chat');
    expect(html).not.toContain('Sessions');
  });

  it('preserves a standalone terminal-only creation action without chat or split actions', () => {
    let createdTerminals = 0;
    const html = renderWorkspaceTabs({
      worktreeId: null,
      canCreateTerminal: true,
      onCreateTerminal: () => createdTerminals++,
    });

    expect(findButtonMarkup(html, 'aria-label="New terminal"')).not.toContain(
      'aria-haspopup="menu"'
    );
    expect(html).not.toContain('New chat');
    expect(html).not.toContain('Tab options');
    expect(html).not.toContain('Sessions');
    getButtonProps('New terminal').onClick?.({} as React.MouseEvent<HTMLButtonElement>);
    expect(createdTerminals).toBe(1);
  });

  it('keeps terminal selection, accessible status, close actions, and creation alongside chats', () => {
    const terminal = {
      id: 'terminal_first',
      title: 'Terminal 1',
      cloudAgentSessionId: 'agent_first',
    };
    const html = renderWorkspaceTabs(
      {
        activeTabId: terminalTabId(terminal.id),
        terminals: [terminal],
        terminalStatuses: {
          [terminal.id]: { status: 'connected', statusText: 'Connected to workspace' },
        },
        canCreateTerminal: true,
      },
      true
    );

    expect(findButtonMarkup(html, 'First worktree chat')).toContain('aria-selected="false"');
    expect(findButtonMarkup(html, terminal.title)).toContain('aria-selected="true"');
    expect(findButtonMarkup(html, terminal.title)).toContain('data-state="active"');
    expect(findButtonMarkup(html, terminal.title)).toContain('Connected to workspace');
    expect(findMenuItemMarkup(html, 'No closed sessions')).toContain('aria-disabled="true"');
    expect(html).not.toContain('Open tab');
    expect(html).toContain('aria-label="Close Terminal 1"');
    expect(html).not.toContain('Session actions for');
    expect(html).toContain('New chat');
    expect(html).toContain('New terminal');
  });
});
