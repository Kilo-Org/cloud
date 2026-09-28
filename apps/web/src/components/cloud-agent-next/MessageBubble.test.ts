import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AssistantMessage } from '@/types/opencode.gen';
import type { StoredMessage } from './types';
import { WORKTREE_REVIEW_PROMPT_INTRO, type WorktreeReviewComment } from './worktree-review';

jest.mock('./PartRenderer', () => ({ PartRenderer: () => null }));
jest.mock('@/components/shared/TimeAgo', () => ({ TimeAgo: () => null }));
jest.mock('@/components/shared/CopyMessageButton', () => ({ CopyMessageButton: () => null }));
jest.mock('../../../node_modules/@pierre/diffs/dist/utils/iterateOverDiff.js', () => ({
  iterateOverDiff: () => [],
}));

import { MessageBubble } from './MessageBubble';

const reviewComment: WorktreeReviewComment = {
  id: 'comment-1',
  anchor: {
    capture: {
      userId: 'user-1',
      organizationId: undefined,
      workspaceScope: 'workspace-1',
      sourceCloudAgentSessionId: 'source-session',
      revision: 3,
      capturedAt: '2026-09-09T09:00:00.000Z',
      comparison: {
        baseRef: 'main',
        mergeBase: 'a'.repeat(40),
        head: 'b'.repeat(40),
      },
    },
    path: 'src/example.ts',
    range: { side: 'additions', startLine: 4, endLine: 4 },
    quote: {
      source: 'saved-patch',
      lines: [{ lineNumber: 4, kind: 'addition', text: 'const value = 1;\n' }],
    },
  },
  text: 'Use the shared value helper.',
};

function reviewMessage(overall?: string): string {
  return `${WORKTREE_REVIEW_PROMPT_INTRO}\n\n${JSON.stringify({
    version: 1,
    overall: overall?.trim() || undefined,
    comments: [{ ...reviewComment, contextStatus: 'current-saved-capture' }],
  })}`;
}

function userMessage(text: string): StoredMessage {
  return {
    info: {
      id: 'msg-review',
      sessionID: 'ses-1',
      role: 'user',
      time: { created: 1 },
      agent: 'build',
      model: { providerID: 'openrouter', modelID: 'anthropic/claude-sonnet-4' },
    },
    parts: [
      {
        id: 'part-review',
        sessionID: 'ses-1',
        messageID: 'msg-review',
        type: 'text',
        text,
      },
    ],
  };
}

describe('MessageBubble', () => {
  it('renders a sanitized string assistant error', () => {
    const info: AssistantMessage = {
      id: 'msg-1',
      sessionID: 'ses-1',
      role: 'assistant',
      time: { created: 1, completed: 2 },
      parentID: 'msg-parent',
      modelID: 'test-model',
      providerID: 'test-provider',
      mode: 'code',
      agent: 'test-agent',
      path: { cwd: '/', root: '/' },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    };
    Object.defineProperty(info, 'error', {
      value: 'Assistant request was rate limited',
      enumerable: true,
    });
    const message: StoredMessage = {
      info,
      parts: [],
    };

    const html = renderToStaticMarkup(React.createElement(MessageBubble, { message }));

    expect(html).toContain('Assistant request was rate limited');
    expect(html).toContain('Failed');
  });

  it('renders an aborted assistant message as Interrupted', () => {
    const info: AssistantMessage = {
      id: 'msg-2',
      sessionID: 'ses-1',
      role: 'assistant',
      time: { created: 1 },
      parentID: 'msg-parent',
      modelID: 'test-model',
      providerID: 'test-provider',
      mode: 'code',
      agent: 'test-agent',
      path: { cwd: '/', root: '/' },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    };
    Object.defineProperty(info, 'error', {
      value: { name: 'MessageAbortedError', data: { message: 'aborted' } },
      enumerable: true,
    });
    const message: StoredMessage = {
      info,
      parts: [],
    };

    const html = renderToStaticMarkup(React.createElement(MessageBubble, { message }));

    expect(html).toContain('Interrupted');
    expect(html).not.toContain('Failed');
  });

  it('does not treat a null assistant error as Failed', () => {
    const info: AssistantMessage = {
      id: 'msg-3',
      sessionID: 'ses-1',
      role: 'assistant',
      time: { created: 1, completed: 2 },
      parentID: 'msg-parent',
      modelID: 'test-model',
      providerID: 'test-provider',
      mode: 'code',
      agent: 'test-agent',
      path: { cwd: '/', root: '/' },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    };
    Object.defineProperty(info, 'error', {
      value: null,
      enumerable: true,
    });
    const message: StoredMessage = {
      info,
      parts: [],
    };

    const html = renderToStaticMarkup(React.createElement(MessageBubble, { message }));

    expect(html).not.toContain('Failed');
    expect(html).not.toContain('Interrupted');
  });

  it('does not emit javascript hrefs from user-message autolinks', () => {
    const message: StoredMessage = {
      info: {
        id: 'msg-user',
        sessionID: 'ses-1',
        role: 'user',
        time: { created: 1 },
        agent: 'build',
        model: { providerID: 'openrouter', modelID: 'anthropic/claude-sonnet-4' },
      },
      parts: [
        {
          id: 'p1',
          sessionID: 'ses-1',
          messageID: 'msg-user',
          type: 'text',
          text: 'see https://example.com and javascript:alert(1)',
        },
      ],
    };

    const html = renderToStaticMarkup(React.createElement(MessageBubble, { message }));

    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('javascript:alert(1)');
  });

  it('renders a parsed review as a compact card without exposing the JSON payload', () => {
    const raw = reviewMessage('  Check the boundary first.  ');
    const html = renderToStaticMarkup(
      React.createElement(MessageBubble, { message: userMessage(raw) })
    );

    expect(html).toContain('Code review feedback');
    expect(html).toContain('1 file · 1 comment');
    expect(html).toContain('cursor-pointer');
    expect(html).not.toContain('Check the boundary first.');
    expect(html).not.toContain('Use the shared value helper.');
    expect(html).not.toContain('"version":1');
    expect(html).not.toContain('Please address the following worktree review feedback');
    expect(html).toContain('<button');
    expect(html).toContain('data-state="closed"');
  });

  it('keeps malformed review JSON and ordinary user prompts as ordinary bubbles', () => {
    const malformed = `${reviewMessage()} trailing text`;
    const malformedHtml = renderToStaticMarkup(
      React.createElement(MessageBubble, { message: userMessage(malformed) })
    );
    const ordinaryHtml = renderToStaticMarkup(
      React.createElement(MessageBubble, { message: userMessage('Please inspect this file.') })
    );

    expect(malformedHtml).not.toContain('Code review feedback');
    expect(malformedHtml).toContain('Please address the following worktree review feedback');
    expect(ordinaryHtml).not.toContain('Code review feedback');
    expect(ordinaryHtml).toContain('Please inspect this file.');
  });
});
