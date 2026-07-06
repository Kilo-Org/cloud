import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AssistantMessage } from '@/types/opencode.gen';
import type { StoredMessage } from './types';

jest.mock('./PartRenderer', () => ({ PartRenderer: () => null }));
jest.mock('@/components/shared/TimeAgo', () => ({ TimeAgo: () => null }));

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
});
