import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { StoredMessage } from '@/components/cloud-agent-next/types';
import { SharedSessionTranscript } from './shared-session-transcript';

jest.mock('@/components/cloud-agent-next/MessageBubble', () => ({
  MessageBubble: ({ message }: { message: { info: { id: string } } }) =>
    React.createElement('div', { 'data-user-message': message.info.id }),
}));
jest.mock('@/components/cloud-agent-next/PartRenderer', () => ({
  PartRenderer: ({ part }: { part: { id: string; type: string; text?: string; tool?: string } }) =>
    React.createElement('div', { 'data-part': part.id }, part.text ?? part.tool),
}));

function makeUserMessage(): StoredMessage {
  return {
    info: {
      id: 'user_1',
      sessionID: 'ses_1',
      role: 'user',
      time: { created: 1 },
      agent: 'build',
      model: { providerID: 'openrouter', modelID: 'anthropic/claude-sonnet-4' },
    },
    parts: [
      {
        id: 'user_text',
        sessionID: 'ses_1',
        messageID: 'user_1',
        type: 'text',
        text: 'Please inspect this.',
      },
    ],
  };
}

function makeAssistantMessage(): StoredMessage {
  return {
    info: {
      id: 'assistant_1',
      sessionID: 'ses_1',
      role: 'assistant',
      time: { created: 2, completed: 3 },
      parentID: 'user_1',
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
    },
    parts: [
      {
        id: 'reason_1',
        sessionID: 'ses_1',
        messageID: 'assistant_1',
        type: 'reasoning',
        text: 'I should read the file first.',
        time: { start: 1, end: 2001 },
      },
      {
        id: 'tool_1',
        sessionID: 'ses_1',
        messageID: 'assistant_1',
        type: 'tool',
        callID: 'call_1',
        tool: 'read',
        state: {
          status: 'completed',
          input: { filePath: 'src/app.ts' },
          output: 'file contents',
          title: 'read',
          metadata: {},
          time: { start: 10, end: 2010 },
        },
      },
      {
        id: 'text_1',
        sessionID: 'ses_1',
        messageID: 'assistant_1',
        type: 'text',
        text: 'The file looks fine.',
      },
    ],
  };
}

describe('SharedSessionTranscript', () => {
  it('shows chat and keeps agent work collapsed by default', () => {
    const html = renderToStaticMarkup(
      React.createElement(SharedSessionTranscript, {
        messages: [makeUserMessage(), makeAssistantMessage()],
      })
    );

    expect(html).toContain('data-user-message="user_1"');
    expect(html).toContain('The file looks fine.');
    expect(html).toContain('Worked for 4s');
    expect(html).toContain('1 tool call');
    expect(html).not.toContain('data-part="reason_1"');
    expect(html).not.toContain('data-part="tool_1"');
  });

  it('renders an empty-state when there are no messages', () => {
    const html = renderToStaticMarkup(
      React.createElement(SharedSessionTranscript, { messages: [] })
    );
    expect(html).toContain('This session has no messages yet.');
  });
});
