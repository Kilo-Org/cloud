import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatSidebar } from './ChatSidebar';
import { useStackedWorkspaceSource } from './hooks/useStackedWorkspaceSource';
import type { StoredSession } from './types';

Object.assign(globalThis, { React });

jest.mock('next/navigation', () => ({
  useRouter: () => ({}),
  usePathname: () => '/cloud/chat',
}));
jest.mock('./hooks/useStackedWorkspaceSource', () => ({
  useStackedWorkspaceSource: jest.fn(() => ({ isPending: false })),
}));

it('does not mount hidden workspace menu queries for every sidebar row', () => {
  const sessions = Array.from({ length: 120 }, (_, index): StoredSession => ({
    sessionId: `ses_${index}`,
    worktreeId: `worktree_${index}`,
    repository: 'example/repo',
    prompt: `Workspace ${index}`,
    mode: 'code',
    model: 'test-model',
    status: 'completed',
    createdAt: '2026-11-10T10:00:00Z',
    updatedAt: '2026-11-10T10:00:00Z',
    messages: [],
  }));
  const html = renderToStaticMarkup(
    createElement(ChatSidebar, {
      sessions,
      onCreateWorktreeChat: jest.fn(),
      onRenameWorktree: jest.fn(),
      onDeleteWorktree: jest.fn(),
    })
  );
  expect(html.match(/data-worktree-id=/g)).toHaveLength(120);
  expect(html.match(/Worktree actions for/g)).toHaveLength(120);
  expect(useStackedWorkspaceSource).not.toHaveBeenCalled();
});
