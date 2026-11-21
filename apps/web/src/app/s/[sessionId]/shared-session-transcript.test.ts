import React from 'react';
Object.assign(globalThis, { React });
import { renderToStaticMarkup } from 'react-dom/server';
import type { StoredMessage } from '@/components/cloud-agent-next/types';
import { SharedSessionTranscript } from './shared-session-transcript';

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

function makeAssistantInfo(id: string, created: number): StoredMessage['info'] {
  return {
    id,
    sessionID: 'ses_1',
    role: 'assistant',
    time: { created, completed: created + 1 },
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
  };
}

function makeAssistantMessage(): StoredMessage {
  return {
    info: makeAssistantInfo('assistant_1', 2),
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

function makeBackgroundTaskMessage(
  state: 'completed' | 'error',
  synthetic = true,
  background = true
): StoredMessage {
  const action = state === 'completed' ? 'completed' : 'failed';
  const tag = state === 'completed' ? 'task_result' : 'task_error';
  return {
    info: { ...makeUserMessage().info, id: 'user_task_result' },
    parts: [
      {
        id: 'task_result',
        sessionID: 'ses_1',
        messageID: 'user_task_result',
        type: 'text',
        synthetic,
        metadata: { background },
        text: [
          `<task id="ses_child" state="${state}">`,
          `<summary>Background task ${action}: Inspect the file</summary>`,
          `<${tag}>`,
          'Detail from the subagent.',
          `</${tag}>`,
          '</task>',
        ].join('\n'),
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

    expect(html).toContain('data-message-id="user_1"');
    expect(html).toContain('The file looks fine.');
    expect(html).toContain('Worked for 4s');
    expect(html).toContain('1 tool call');
    expect(html).not.toContain('data-part="reason_1"');
    expect(html).not.toContain('data-part="tool_1"');
  });

  it.each([
    ['completed', 'Subagent finished'],
    ['error', 'Subagent failed'],
  ] as const)('shows a Kilo v1 %s background task as a collapsed result', (state, title) => {
    const html = renderToStaticMarkup(
      React.createElement(SharedSessionTranscript, {
        messages: [makeUserMessage(), makeBackgroundTaskMessage(state), makeAssistantMessage()],
      })
    );

    expect(html).toContain('Please inspect this.');
    expect(html).toContain('The file looks fine.');
    expect(html).toContain('data-message-id="user_task_result"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(title);
    expect(html).toContain('Inspect the file');
    expect(html).not.toContain('&lt;task');
    expect(html).not.toContain('Detail from the subagent.');
  });

  it.each([
    makeBackgroundTaskMessage('completed', false),
    makeBackgroundTaskMessage('completed', true, false),
  ])('keeps task-like text without both background markers as chat', message => {
    const html = renderToStaticMarkup(
      React.createElement(SharedSessionTranscript, { messages: [message] })
    );

    expect(html).not.toContain('Subagent finished');
    expect(html).toContain('Detail from the subagent.');
  });

  it('renders an empty-state when there are no messages', () => {
    const html = renderToStaticMarkup(
      React.createElement(SharedSessionTranscript, { messages: [] })
    );
    expect(html).toContain('This session has no messages yet.');
  });

  it('renders a load-failure message when the snapshot is unavailable', () => {
    const html = renderToStaticMarkup(
      React.createElement(SharedSessionTranscript, { messages: [], unavailable: true })
    );
    expect(html).toContain('Couldn&#x27;t load this transcript. Refresh the page to try again.');
    expect(html).not.toContain('This session has no messages yet.');
  });
});

jest.mock('@/components/cloud-agent-next/worktree-review', () => ({
  parseWorktreeReviewMessage: () => null,
}));
jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) =>
    React.createElement('p', null, children),
}));
jest.mock('remark-gfm', () => ({ __esModule: true, default: () => undefined }));
