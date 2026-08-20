import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AssistantMessage } from '@/types/opencode.gen';
import type { StoredMessage } from './types';

jest.mock('./PartRenderer', () => ({ PartRenderer: () => null }));
jest.mock('@/components/shared/TimeAgo', () => ({ TimeAgo: () => null }));
jest.mock('@/components/shared/CopyMessageButton', () => ({ CopyMessageButton: () => null }));

import { MessageBubble } from './MessageBubble';

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
});
