import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { atom } from 'jotai';
import type {
  PreparationAttempt,
  SessionManager,
  StandaloneQuestion,
  StandaloneSuggestion,
} from '@kilocode/cloud-agent-sdk';
import type { AssistantMessage } from '@/types/opencode.gen';
import type { Part, ReasoningPart, StoredMessage, TextPart, ToolPart } from './types';
import type * as ToolCardShellModule from './ToolCardShell';
import { useOptionalManager } from './CloudAgentProvider';

let mockExpanded = false;

jest.mock('./ToolCardShell', () => {
  const actual = jest.requireActual<typeof ToolCardShellModule>('./ToolCardShell');
  return {
    ToolCardShell: (props: React.ComponentProps<typeof actual.ToolCardShell>) =>
      React.createElement(actual.ToolCardShell, {
        ...props,
        defaultExpanded: mockExpanded ? true : props.defaultExpanded,
      }),
  };
});
jest.mock('./CloudAgentProvider', () => ({ useOptionalManager: jest.fn() }));
jest.mock('@/components/shared/TimeAgo', () => ({
  TimeAgo: () => React.createElement('time', null, 'Message timestamp'),
}));
jest.mock('@/components/shared/CopyMessageButton', () => ({ CopyMessageButton: () => null }));
jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) =>
    React.createElement('p', null, children),
}));
jest.mock('remark-gfm', () => ({ __esModule: true, default: () => undefined }));

import { ConversationMessages } from './ConversationMessages';
import { PartRenderer } from './PartRenderer';

Object.assign(globalThis, { React });

function assistantMessage(
  id: string,
  parts: Part[],
  overrides: Partial<AssistantMessage> = {}
): StoredMessage {
  const info: AssistantMessage = {
    id,
    sessionID: 'ses-1',
    role: 'assistant',
    time: { created: 1, completed: 2 },
    parentID: 'user-1',
    modelID: 'test-model',
    providerID: 'test-provider',
    mode: 'code',
    agent: 'test-agent',
    path: { cwd: '/', root: '/' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...overrides,
  };
  return {
    info,
    parts: parts.map(part => ({ ...part, messageID: id, sessionID: info.sessionID })),
  };
}

function textPart(id: string, text: string): TextPart {
  return { id, sessionID: 'ses-1', messageID: 'assistant-1', type: 'text', text };
}

function reasoningPart(id: string, overrides: Partial<ReasoningPart> = {}): ReasoningPart {
  return {
    id,
    sessionID: 'ses-1',
    messageID: 'assistant-1',
    type: 'reasoning',
    text: `Reasoning details for ${id}`,
    time: { start: 1, end: 2 },
    ...overrides,
  };
}

function toolPart(
  id: string,
  tool = 'bash',
  state: ToolPart['state'] = {
    status: 'completed',
    input: { command: `pnpm test -- ${id}` },
    output: `Output for ${id}`,
    title: tool,
    metadata: {},
    time: { start: 1, end: 2 },
  }
): ToolPart {
  return {
    id,
    sessionID: 'ses-1',
    messageID: 'assistant-1',
    type: 'tool',
    callID: id,
    tool,
    state,
  };
}

function renderConversation(
  staticMessages: StoredMessage[],
  overrides: Partial<React.ComponentProps<typeof ConversationMessages>> = {}
): string {
  return renderToStaticMarkup(
    React.createElement(ConversationMessages, {
      active: true,
      isStreaming: false,
      staticMessages,
      dynamicMessages: [],
      pendingMessages: new Map(),
      preparationByMessageId: new Map(),
      onOpenPreparationDetails: jest.fn(),
      ...overrides,
    })
  );
}

function buttons(html: string): string[] {
  return html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
}

beforeEach(() => {
  mockExpanded = false;
  jest.mocked(useOptionalManager).mockReturnValue(null);
});

describe('ConversationMessages', () => {
  it('shows individual rows in transcript order with collapsed details and metadata after the answer', () => {
    const html = renderConversation([
      assistantMessage('assistant-1', [
        reasoningPart('reasoning-1'),
        toolPart('bash-1'),
        textPart('progress', 'First check passed.'),
        toolPart('bash-2'),
        textPart('answer', 'The implementation is ready.'),
      ]),
    ]);
    const renderedButtons = buttons(html);

    expect(renderedButtons).toEqual([
      expect.stringContaining('Thought'),
      expect.stringContaining('pnpm test -- bash-1'),
      expect.stringContaining('pnpm test -- bash-2'),
    ]);
    for (const button of renderedButtons) {
      expect(button).toContain('aria-expanded="false"');
      expect(button).toContain('aria-controls=');
    }
    expect(html).not.toContain('Reasoning details');
    expect(html).not.toContain('Output for');
    expect(html).toContain('First check passed.');
    expect(html).toContain('The implementation is ready.');
    expect(html).toContain('Message timestamp');
    expect(html.indexOf('pnpm test -- bash-1')).toBeLessThan(html.indexOf('First check passed.'));
    expect(html.indexOf('First check passed.')).toBeLessThan(html.indexOf('pnpm test -- bash-2'));
    expect(html.indexOf('pnpm test -- bash-2')).toBeLessThan(
      html.indexOf('The implementation is ready.')
    );
    expect(html.indexOf('Message timestamp')).toBeGreaterThan(
      html.indexOf('The implementation is ready.')
    );
  });

  it('dispatches the new tool cards as independent rows without a group disclosure', () => {
    const parts = [
      { tool: 'background_process', input: { action: 'start', command: 'pnpm dev' } },
      {
        tool: 'apply_patch',
        input: { patchText: '*** Begin Patch\n*** Add File: result.txt\n+Updated\n*** End Patch' },
      },
      { tool: 'webfetch', input: { url: 'https://example.com/docs' } },
      { tool: 'codesearch', input: { query: 'findParser' } },
    ].map(({ tool, input }) =>
      toolPart(tool, tool, {
        status: 'completed',
        input,
        output: `Output for ${tool}`,
        title: tool,
        metadata: {},
        time: { start: 1, end: 2 },
      })
    );
    const html = renderConversation([
      assistantMessage('assistant-1', [...parts, textPart('answer', 'The tools finished.')]),
    ]);
    const renderedButtons = buttons(html);

    expect(renderedButtons).toEqual([
      expect.stringContaining('Start background process'),
      expect.stringContaining('Apply patch'),
      expect.stringContaining('CodeSearch'),
    ]);
    expect(renderedButtons[0]).toContain('pnpm dev');
    expect(renderedButtons[2]).toContain('findParser');
    for (const button of renderedButtons) {
      expect(button).toContain('aria-expanded="false"');
      expect(button).toContain('aria-controls=');
      expect(button).not.toContain('disabled=');
    }
    expect(new Set(html.match(/aria-controls="[^"]+"/g)).size).toBe(3);
    expect(html.match(/data-tool-card=/g)).toHaveLength(4);
    expect(html).toContain('WebFetch');
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).not.toContain('Output for');
    expect(html.indexOf('Apply patch')).toBeLessThan(html.indexOf('WebFetch'));
    expect(html.indexOf('WebFetch')).toBeLessThan(html.indexOf('CodeSearch'));
    expect(html.indexOf('CodeSearch')).toBeLessThan(html.indexOf('The tools finished.'));
  });

  it('keeps every row visible across static and dynamic messages in the same assistant turn', () => {
    const html = renderConversation(
      [assistantMessage('assistant-1', [reasoningPart('reasoning-1'), toolPart('bash-1')])],
      {
        dynamicMessages: [
          assistantMessage('assistant-2', [reasoningPart('reasoning-2'), toolPart('bash-2')]),
          assistantMessage('assistant-3', [textPart('answer', 'Both checks passed.')]),
        ],
      }
    );
    const renderedButtons = buttons(html);

    expect(renderedButtons).toEqual([
      expect.stringContaining('Thought'),
      expect.stringContaining('pnpm test -- bash-1'),
      expect.stringContaining('Thought'),
      expect.stringContaining('pnpm test -- bash-2'),
    ]);
    for (const button of renderedButtons) {
      expect(button).toContain('aria-expanded="false"');
    }
    expect(html).toContain('Both checks passed.');
    expect(html).not.toContain('Reasoning details');
    expect(html).not.toContain('Output for');
    expect(html.match(/data-message-role="assistant"/g)).toHaveLength(1);
    expect(html.match(/<time>/g)).toHaveLength(1);
  });

  it.each([
    {
      name: 'failure',
      error: { name: 'UnknownError', data: { message: 'Request was rate limited' } },
      status: 'Failed',
      detail: 'Request was rate limited',
      absent: 'Interrupted',
    },
    {
      name: 'interruption',
      error: { name: 'MessageAbortedError', data: { message: 'aborted' } },
      status: 'Interrupted',
      detail: 'Partial answer',
      absent: 'Failed',
    },
  ] satisfies {
    name: string;
    error: NonNullable<AssistantMessage['error']>;
    status: string;
    detail: string;
    absent: string;
  }[])('keeps assistant $name visible while a neighboring message streams', testCase => {
    const html = renderConversation(
      [
        assistantMessage('assistant-1', [toolPart('bash-1')]),
        assistantMessage(
          'assistant-2',
          [
            reasoningPart('unfinished', { time: { start: 1 } }),
            textPart('partial-answer', 'Partial answer'),
          ],
          { time: { created: 3 }, error: testCase.error }
        ),
      ],
      {
        isStreaming: true,
        dynamicMessages: [
          assistantMessage(
            'assistant-3',
            [
              toolPart('active', 'bash', {
                status: 'running',
                input: { command: 'pnpm test' },
                time: { start: 4 },
              }),
            ],
            { time: { created: 4 } }
          ),
        ],
      }
    );

    expect(html).toContain(testCase.status);
    expect(html).toContain(testCase.detail);
    expect(html).toContain('Partial answer');
    expect(html).not.toContain(testCase.absent);
    expect(html.match(/data-message-role="assistant"/g)).toHaveLength(3);
    expect(buttons(html)).toEqual([
      expect.stringContaining('Shell'),
      expect.stringContaining('Thought'),
      expect.stringContaining('Shell'),
    ]);
  });

  it('keeps pending tools, running tools, and streaming reasoning individually collapsed', () => {
    const html = renderConversation(
      [assistantMessage('assistant-1', [reasoningPart('reasoning-1'), toolPart('bash-1')])],
      {
        isStreaming: true,
        dynamicMessages: [
          assistantMessage(
            'assistant-2',
            [
              toolPart('pending', 'bash', {
                status: 'pending',
                input: { command: 'pnpm lint' },
                raw: '',
              }),
              toolPart('active', 'bash', {
                status: 'running',
                input: { command: 'pnpm typecheck' },
                time: { start: 3 },
              }),
              reasoningPart('active-reasoning', { time: { start: 3 } }),
            ],
            { time: { created: 3 } }
          ),
        ],
      }
    );
    const renderedButtons = buttons(html);

    expect(renderedButtons).toEqual([
      expect.stringContaining('Thought'),
      expect.stringContaining('pnpm test -- bash-1'),
      expect.stringContaining('pnpm lint'),
      expect.stringContaining('pnpm typecheck'),
      expect.stringContaining('Thinking'),
    ]);
    for (const button of renderedButtons) {
      expect(button).toContain('aria-expanded="false"');
    }
    expect(html).not.toContain('Reasoning details');
    expect(html).not.toContain('Output for');
    expect(html).not.toContain('Waiting to execute');
    expect(html).not.toContain('Running command');
  });

  it('does not show completed-answer metadata while the last message is streaming', () => {
    const html = renderConversation(
      [assistantMessage('assistant-1', [reasoningPart('completed-reasoning')])],
      {
        isStreaming: true,
        dynamicMessages: [
          assistantMessage(
            'assistant-2',
            [{ ...textPart('answer', 'Here is the result so far'), time: { start: 3 } }],
            { time: { created: 3 } }
          ),
        ],
      }
    );

    expect(buttons(html)).toHaveLength(1);
    expect(buttons(html)[0]).toContain('Thought: 1ms');
    expect(buttons(html)[0]).toContain('aria-expanded="false"');
    expect(html).toContain('Here is the result so far');
    expect(html).not.toContain('Message timestamp');
    expect(html).not.toContain('Reasoning details');
  });

  it('keeps a completed answer idle when an older tool is stale and a later turn starts', () => {
    const html = renderConversation(
      [
        assistantMessage('assistant-1', [
          toolPart('stale-read', 'read', {
            status: 'running',
            input: { filePath: 'README' },
            time: { start: 1 },
          }),
        ]),
        assistantMessage('assistant-2', [textPart('answer', 'The previous turn is complete.')]),
      ],
      {
        isStreaming: true,
        dynamicMessages: [
          assistantMessage(
            'assistant-3',
            [reasoningPart('active-reasoning', { time: { start: 5 } })],
            { parentID: 'user-2', time: { created: 5 } }
          ),
        ],
      }
    );

    expect(html).toContain('The previous turn is complete.');
    expect(buttons(html)).toEqual([
      expect.stringContaining('Read'),
      expect.stringContaining('Thinking'),
    ]);
    expect(html.match(/data-message-role="assistant"/g)).toHaveLength(2);
    expect(html.match(/<time>/g)).toHaveLength(1);
    expect(html.indexOf('Message timestamp')).toBeGreaterThan(
      html.indexOf('The previous turn is complete.')
    );
    expect(html.indexOf('Message timestamp')).toBeLessThan(html.indexOf('Thinking'));
  });

  it.each([false, true])(
    'shows a failed tool alert with the full normalized error despite missing input (streaming=%s)',
    isStreaming => {
      const details = Array.from(
        { length: 40 },
        (_, index) => `Failure detail ${index + 1}: the verification command could not finish.`
      ).join('\n');
      const html = renderConversation(
        [
          assistantMessage('assistant-1', [
            reasoningPart('reasoning-1'),
            toolPart('bash-1'),
            toolPart('failed', 'bash', {
              status: 'error',
              input: {},
              error: `\u001b[31mRetrying\rThe verification command failed\u001b[0m\r\n${details}`,
              time: { start: 3, end: 4 },
            }),
            textPart('answer', 'The check needs attention.'),
          ]),
        ],
        {
          isStreaming,
          dynamicMessages: [
            assistantMessage(
              'assistant-2',
              [{ ...textPart('next-answer', 'Checking the next step.'), time: { start: 5 } }],
              { time: { created: 5 } }
            ),
          ],
        }
      );
      const renderedButtons = buttons(html);

      expect(renderedButtons).toEqual([
        expect.stringContaining('Thought'),
        expect.stringContaining('Shell'),
      ]);
      for (const button of renderedButtons) {
        expect(button).toContain('aria-expanded="false"');
      }
      expect(html.match(/role="alert"/g)).toHaveLength(1);
      expect(html.replace(/<[^>]*>/g, '')).toContain('Failed: bash');
      expect(html).toContain(`The verification command failed\n${details}`);
      expect(html).not.toContain('Retrying');
      expect(html).not.toContain('\u001b');
      expect(html).not.toContain('\r');
      expect(html).not.toContain('Output for');
      expect(html).not.toContain('Reasoning details');
      expect(html).toContain('The check needs attention.');
      expect(html).toContain('Checking the next step.');
      expect(html.indexOf('The verification command failed')).toBeLessThan(
        html.indexOf('The check needs attention.')
      );
    }
  );

  it('keeps live questions, suggestion actions, and child-session controls visible', () => {
    const atoms: Pick<
      SessionManager['atoms'],
      'activeQuestion' | 'isStreaming' | 'activeSuggestion'
    > = {
      activeQuestion: atom<StandaloneQuestion | null>(null),
      isStreaming: atom(true),
      activeSuggestion: atom<StandaloneSuggestion | null>({
        requestId: 'suggestion-1',
        callId: 'suggest-1',
        text: 'Run the focused checks next?',
        actions: [{ label: 'Run checks', prompt: 'Run the focused verification' }],
      }),
    };
    jest.mocked(useOptionalManager).mockReturnValue({ atoms } as SessionManager);
    const childSessionId = `ses_${'a'.repeat(26)}`;
    const childMessages = [
      assistantMessage(
        'child-1',
        [
          reasoningPart('child-reasoning'),
          toolPart('child-completed'),
          textPart('child-answer', 'Child transcript stays in the drawer.'),
          toolPart('child-running', 'read', {
            status: 'running',
            input: { filePath: '/repo/src/parser.ts' },
            time: { start: 4 },
          }),
        ],
        { sessionID: childSessionId, time: { created: 3 } }
      ),
    ];
    const html = renderConversation(
      [
        assistantMessage('assistant-1', [
          reasoningPart('reasoning-1'),
          toolPart('bash-1'),
          toolPart('question-1', 'question', { status: 'pending', input: {}, raw: '' }),
          toolPart('suggest-1', 'suggest', { status: 'pending', input: {}, raw: '' }),
          toolPart('task-1', 'task', {
            status: 'running',
            input: { description: 'Inspect the parser', subagent_type: 'explore' },
            metadata: { sessionId: childSessionId },
            time: { start: 3 },
          }),
          {
            id: 'report',
            sessionID: 'ses-1',
            messageID: 'assistant-1',
            type: 'file',
            mime: 'text/plain',
            filename: 'report.txt',
            url: 'https://example.com/report.txt',
          },
          {
            id: 'subtask',
            sessionID: 'ses-1',
            messageID: 'assistant-1',
            type: 'subtask',
            agent: 'explore',
            description: 'Review the results',
            prompt: 'Review the parser checks',
          },
        ]),
      ],
      {
        isStreaming: true,
        onOpenChildSession: jest.fn(),
        getChildMessages: sessionId => (sessionId === childSessionId ? childMessages : []),
      }
    );
    const renderedButtons = buttons(html);
    const disclosures = renderedButtons.filter(button => button.includes('aria-expanded='));

    expect(html).toContain('Waiting for answer');
    expect(html).toContain('Run the focused checks next?');
    for (const label of ['Run checks', 'Dismiss', 'Inspect the parser']) {
      const control = renderedButtons.find(button => button.includes(label));
      expect(control).toBeDefined();
      expect(control).not.toContain('disabled=');
    }
    const childControl = renderedButtons.find(button => button.includes('Inspect the parser'));
    expect(childControl).toContain('>Explore<');
    expect(childControl).not.toContain('explore Agent');
    expect(childControl).toMatch(/<title>Working<\/title>[\s\S]*Inspect the parser/);
    expect(childControl).toContain('>Read parser.ts<');
    expect(childControl).not.toContain('Latest:');
    expect(childControl).toContain('2 tool calls');
    expect(childControl).toContain('aria-busy="true"');
    expect(childControl).not.toContain('aria-expanded=');
    expect(html).not.toContain('Child transcript stays in the drawer.');
    expect(html).not.toContain('Reasoning details for child-reasoning');
    expect(html).toContain('href="https://example.com/report.txt"');
    expect(html).toContain('report.txt');
    expect(html).toContain('Review the results');
    expect(disclosures).toEqual([
      expect.stringContaining('Thought'),
      expect.stringContaining('Shell'),
    ]);
    for (const disclosure of disclosures) {
      expect(disclosure).toContain('aria-expanded="false"');
    }
    expect(html).not.toContain('Reasoning details');
    expect(html).not.toContain('Output for');
  });

  it.each(['pending', 'running', 'completed', 'error'] as const)(
    'keeps latest child activity visible after its state becomes %s',
    status => {
      const sessionId = `ses_${'c'.repeat(26)}`;
      const input = { filePath: '/repo/package.json' };
      const state: ToolPart['state'] =
        status === 'pending'
          ? { status, input, raw: '' }
          : status === 'running'
            ? { status, input, time: { start: 2 } }
            : status === 'error'
              ? { status, input, error: 'Read failed', time: { start: 2, end: 3 } }
              : {
                  status,
                  input,
                  output: '{}',
                  title: 'Read package',
                  metadata: {},
                  time: { start: 2, end: 3 },
                };
      const childMessages = [
        assistantMessage('child-1', [
          toolPart('older-running', 'bash', {
            status: 'running',
            input: { command: 'pnpm test' },
            time: { start: 1 },
          }),
          toolPart('latest-read', 'read', state),
          reasoningPart('between-tools'),
        ]),
      ];
      const parent = assistantMessage('parent', [
        toolPart('task', 'task', {
          status: 'running',
          input: { description: 'Explore repository', subagent_type: 'explore' },
          metadata: { sessionId },
          time: { start: 1 },
        }),
      ]);
      const render = () =>
        renderConversation([parent], {
          isStreaming: true,
          onOpenChildSession: jest.fn(),
          getChildMessages: () => childMessages,
        });
      const html = render();

      expect(html).toContain(`>Read package.json${status === 'error' ? ' (failed)' : ''}<`);
      expect(html).not.toContain('Shell pnpm');
      expect(html).not.toContain('Working...');
      expect(html).toContain('2 tool calls');
      expect(html).toContain('aria-busy="true"');
      expect(html.indexOf('Explore repository')).toBeLessThan(html.indexOf('>Explore<'));

      childMessages.push(
        assistantMessage('child-2', [
          toolPart('next-read', 'read', {
            status: 'running',
            input: { filePath: '/repo/README.md' },
            time: { start: 4 },
          }),
        ])
      );
      const next = render();
      expect(next).toContain('>Read README.md<');
      expect(next).not.toContain('Read package.json');
      expect(next).toContain('3 tool calls');
      expect(next).toContain('aria-busy="true"');
    }
  );

  it.each(['pending', 'running'] as const)(
    'keeps a progress line before %s child activity arrives',
    status => {
      const state: ToolPart['state'] =
        status === 'pending'
          ? { status, input: { description: 'Explore repository' }, raw: '' }
          : { status, input: { description: 'Explore repository' }, time: { start: 1 } };
      const html = renderConversation([
        assistantMessage('parent', [toolPart('task', 'task', state)]),
      ]);

      expect(html).toContain(status === 'pending' ? 'Delegating...' : 'Working...');
      expect(html).toContain(`<title>${status === 'pending' ? 'Delegating' : 'Working'}</title>`);
      expect(html).toContain('aria-busy="true"');
      expect(html).not.toContain('0 tool calls');
      expect(html).not.toContain('Completed');
    }
  );

  it('retains an enabled inline child-session control when no drawer callback is provided', () => {
    const sessionId = `ses_${'b'.repeat(26)}`;
    const childMessages = [
      assistantMessage(
        'child-1',
        [toolPart('child-tool'), textPart('child-answer', 'The child session result.')],
        { sessionID: sessionId }
      ),
    ];
    const html = renderConversation(
      [
        assistantMessage('assistant-1', [
          toolPart('task-1', 'task', {
            status: 'completed',
            input: { description: 'Inspect the parser', subagent_type: 'explore' },
            output: '',
            title: 'Parser inspection',
            metadata: { sessionId },
            time: { start: 1, end: 2 },
          }),
        ]),
      ],
      { getChildMessages: childSessionId => (childSessionId === sessionId ? childMessages : []) }
    );

    expect(buttons(html)).toEqual([expect.stringContaining('Inspect the parser')]);
    expect(buttons(html)[0]).toContain('>Explore<');
    expect(buttons(html)[0]).toContain('Completed');
    expect(buttons(html)[0]).not.toContain('<title>Working</title>');
    expect(buttons(html)[0]).not.toContain('>Shell pnpm<');
    expect(buttons(html)[0]).toContain('1 tool call');
    expect(buttons(html)[0]).not.toContain('1 tool calls');
    expect(buttons(html)[0]).not.toContain('aria-busy="true"');
    expect(buttons(html)[0]).not.toContain('disabled=');
    expect(html).not.toContain('The child session result.');
  });

  it.each([false, true])(
    'renders no disclosure or spacing for a hidden-only reasoning transcript (streaming=%s)',
    isStreaming => {
      const hidden = [
        reasoningPart('empty', { text: '', time: { start: 1 } }),
        reasoningPart('blank', { text: ' \n\t ' }),
        reasoningPart('redacted', { text: '[REDACTED]' }),
        reasoningPart('repeated-redactions', { text: ' [REDACTED]\n[REDACTED][REDACTED]\t ' }),
        reasoningPart('comment-placeholder', { text: '<!-- reasoning unavailable -->' }),
        reasoningPart('comment-and-redaction', { text: '[REDACTED]<!-- placeholder -->' }),
        reasoningPart('unfinished-comment', { text: '<!--', time: { start: 1 } }),
        reasoningPart('openai-encrypted', {
          text: '',
          metadata: { openai: { reasoningEncryptedContent: 'encrypted-reasoning' } },
        }),
        reasoningPart('copilot-encrypted', {
          text: '',
          metadata: { copilot: { reasoningEncryptedContent: 'encrypted-reasoning' } },
        }),
        reasoningPart('openrouter-encrypted', {
          text: ' \n\t ',
          metadata: {
            openrouter: {
              reasoning_details: [{ type: 'reasoning.encrypted', data: 'encrypted-reasoning' }],
            },
          },
        }),
        reasoningPart('anthropic-redacted', {
          text: '',
          metadata: { anthropic: { redactedData: 'redacted-reasoning' } },
        }),
      ];
      const html = renderConversation([assistantMessage('assistant-1', hidden.slice(0, 4))], {
        isStreaming,
        dynamicMessages: [
          assistantMessage('assistant-2', hidden.slice(4), { time: { created: 3 } }),
        ],
      });

      expect(html).toBe('');
      for (const part of hidden) {
        expect(renderToStaticMarkup(React.createElement(PartRenderer, { part, isStreaming }))).toBe(
          ''
        );
      }
    }
  );

  it.each([
    {
      name: 'OpenAI encrypted content',
      metadata: { openai: { reasoningEncryptedContent: 'encrypted-reasoning' } },
    },
    {
      name: 'Copilot encrypted content',
      metadata: { copilot: { reasoningEncryptedContent: 'encrypted-reasoning' } },
    },
    {
      name: 'OpenRouter encrypted-only details',
      metadata: {
        openrouter: {
          reasoning_details: [{ type: 'reasoning.encrypted', data: 'encrypted-reasoning' }],
        },
      },
    },
    {
      name: 'Anthropic signature',
      metadata: { anthropic: { signature: 'reasoning-signature' } },
    },
  ])('previews and expands readable reasoning without changing $name metadata', ({ metadata }) => {
    const text =
      '## Check [REDACTED] the parser\n\nI checked [REDACTED] before choosing the next step.';
    const part = reasoningPart('readable', { text, metadata });
    const original = structuredClone(part);
    const message = assistantMessage('assistant-1', [part]);
    const html = renderConversation([message]);

    expect(buttons(html)).toHaveLength(1);
    expect(buttons(html)[0]).toContain('Thought: Check the parser · 1ms');
    expect(buttons(html)[0]).toContain('aria-expanded="false"');
    expect(html).not.toContain('I checked');
    expect(html).not.toContain('[REDACTED]');

    mockExpanded = true;
    const expanded = renderConversation([message]);

    expect(buttons(expanded)[0]).toContain('aria-expanded="true"');
    expect(expanded).toContain('I checked  before choosing the next step.');
    expect(expanded).not.toContain('[REDACTED]');
    expect(expanded).not.toContain('encrypted-reasoning');
    expect(expanded).not.toContain('reasoning-signature');
    expect(part).toEqual(original);
    expect(message.parts[0]).toEqual(original);
    expect(part.metadata).toBe(metadata);
  });

  it.each([undefined, 1300])(
    'uses the reasoning end time while the assistant is still streaming (end=%s)',
    end => {
      const html = renderConversation([], {
        isStreaming: true,
        dynamicMessages: [
          assistantMessage(
            'assistant-1',
            [
              reasoningPart('reasoning-1', {
                text: '**Inspect the parser**\n\nRead the implementation.',
                time: { start: 100, end },
              }),
            ],
            { time: { created: 100 } }
          ),
        ],
      });
      const header = buttons(html)[0];

      expect(header).toContain(
        end === undefined ? 'Thinking: Inspect the parser' : 'Thought: Inspect the parser · 1.2s'
      );
      expect(header.includes('animate-spin')).toBe(end === undefined);
      expect(header).toContain('aria-expanded="false"');
      expect(html).not.toContain('Read the implementation.');
    }
  );

  it('does not invent elapsed time for stopped reasoning without an end timestamp', () => {
    const html = renderConversation([
      assistantMessage('assistant-1', [reasoningPart('stopped', { time: { start: 100 } })]),
    ]);

    expect(buttons(html)[0]).toContain('>Thought</span>');
    expect(html).not.toContain('animate-spin');
  });

  it.each([false, true])(
    'renders heading-only reasoning as a non-disclosure row (streaming=%s)',
    isStreaming => {
      const html = renderConversation(
        [
          assistantMessage(
            'assistant-1',
            [
              reasoningPart('heading-only', {
                text: '## Inspect the parser\n\n[REDACTED]<!-- placeholder -->',
                time: { start: 1, end: isStreaming ? undefined : 2 },
              }),
            ],
            { time: { created: 1, completed: isStreaming ? undefined : 2 } }
          ),
        ],
        { isStreaming }
      );

      expect(html).toContain(
        isStreaming ? 'Thinking: Inspect the parser' : 'Thought: Inspect the parser · 1ms'
      );
      expect(html.match(/data-message-role="assistant"/g)).toHaveLength(1);
      expect(buttons(html)).toHaveLength(0);
      expect(html).not.toContain('aria-expanded=');
      expect(html).not.toContain('[REDACTED]');
      expect(html).not.toContain('placeholder');
      expect(html).not.toContain('Message timestamp');
    }
  );

  it('keeps preparation details between their triggering message and the next answer', () => {
    const first = assistantMessage('assistant-1', [textPart('first-answer', 'First answer')]);
    const second = assistantMessage('assistant-2', [textPart('second-answer', 'Second answer')]);
    const attempt: PreparationAttempt = {
      id: 'preparation-1',
      triggerMessageId: first.info.id,
      status: 'failed',
      safeError: 'Workspace setup failed',
      startedAt: 1,
      revision: 1,
      steps: [],
    };
    const html = renderConversation([first, second], {
      preparationByMessageId: new Map([[first.info.id, [attempt]]]),
    });

    expect(html).toContain('First answer');
    expect(html).toContain('Second answer');
    expect(html).toContain('Workspace setup failed');
    expect(html.indexOf('Preparation failed')).toBeGreaterThan(html.indexOf('First answer'));
    expect(html.indexOf('Preparation failed')).toBeLessThan(html.indexOf('Second answer'));
    expect(buttons(html).find(button => button.includes('View details'))).toBeDefined();
  });
});

describe('PartRenderer tool lifecycle', () => {
  const pendingState: ToolPart['state'] = { status: 'pending', input: {}, raw: '' };
  const runningState: ToolPart['state'] = {
    status: 'running',
    input: {},
    time: { start: 1 },
  };
  const completedState: ToolPart['state'] = {
    status: 'completed',
    input: {},
    output: 'Stored tool result',
    title: '',
    metadata: {},
    time: { start: 1, end: 2 },
  };
  const errorState: ToolPart['state'] = {
    status: 'error',
    input: {},
    error: 'The tool could not finish.',
    time: { start: 1, end: 2 },
  };

  it.each([
    { tool: 'read', title: 'Read' },
    { tool: 'edit', title: 'Edit' },
    { tool: 'write', title: 'Write' },
    { tool: 'bash', title: 'Shell' },
    { tool: 'glob', title: 'Glob' },
    { tool: 'grep', title: 'Grep' },
    { tool: 'list', title: 'List' },
    { tool: 'websearch', title: 'WebSearch' },
    { tool: 'codesearch', title: 'CodeSearch' },
    { tool: 'webfetch', title: 'WebFetch' },
    { tool: 'background_process', title: 'Check background process' },
    { tool: 'apply_patch', title: 'Apply patch' },
    { tool: 'mcp', title: 'mcp' },
    { tool: 'custom-tool', title: 'custom-tool' },
  ])('waits for missing $tool input only while pending or running', ({ tool, title }) => {
    for (const state of [pendingState, runningState]) {
      const html = renderToStaticMarkup(
        React.createElement(PartRenderer, { part: toolPart(tool, tool, state) })
      );

      expect(html).toContain(tool);
      expect(html).toContain('...');
      expect(buttons(html)).toHaveLength(0);
      expect(html).not.toContain('data-tool-card');
    }

    const html = renderToStaticMarkup(
      React.createElement(PartRenderer, { part: toolPart(tool, tool, completedState) })
    );

    expect(html).toContain(title);
    expect(html).toContain('data-tool-card');
    expect(html).not.toContain('animate-spin');
    expect(html).not.toContain('Failed to render');
    for (const button of buttons(html)) {
      expect(button).toContain('aria-expanded="false"');
    }
  });

  it.each([
    'read',
    'edit',
    'write',
    'bash',
    'background_process',
    'apply_patch',
    'webfetch',
    'codesearch',
    'task',
    'skill',
    'mcp',
    'custom-tool',
  ])('surfaces %s errors even when the input object is missing', tool => {
    const part = toolPart(tool, tool, { ...errorState });
    Object.defineProperty(part.state, 'input', { value: undefined, enumerable: true });
    const html = renderToStaticMarkup(
      React.createElement(PartRenderer, { part, isStreaming: true })
    );

    expect(html).toContain('role="alert"');
    expect(html.replace(/<[^>]*>/g, '')).toContain(`Failed: ${tool}`);
    expect(html).toContain(errorState.error);
    expect(buttons(html)).toHaveLength(0);
    expect(html).not.toContain('animate-spin');
  });

  it.each([
    { tool: 'question', title: 'Questions dismissed' },
    { tool: 'suggest', title: 'Suggestion dismissed' },
    { tool: 'chart', title: 'chart' },
    { tool: 'permission', title: 'permission' },
  ])(
    'preserves the existing $tool error UI instead of an ordinary tool alert',
    ({ tool, title }) => {
      const part = toolPart(tool, tool, errorState);
      const html = renderToStaticMarkup(React.createElement(PartRenderer, { part }));

      expect(buttons(html)).toHaveLength(1);
      expect(buttons(html)[0]).toContain(title);
      expect(buttons(html)[0]).toContain('aria-expanded="false"');
      expect(html).not.toContain('role="alert"');
      expect(html).not.toContain('Failed:');
      expect(html).not.toContain(errorState.error);

      mockExpanded = true;
      const expanded = renderToStaticMarkup(React.createElement(PartRenderer, { part }));

      expect(expanded).toContain(title);
      if (tool === 'chart' || tool === 'permission') {
        expect(expanded).toContain(errorState.error);
      }
    }
  );

  it('omits hidden tool rows and empty assistant messages while retaining completed todos', () => {
    const hidden = [
      toolPart('read-todos', 'todoread', completedState),
      toolPart('enter-plan', 'plan_enter', completedState),
      toolPart('exit-plan', 'plan_exit', completedState),
      toolPart('pending-todos', 'todowrite', pendingState),
      toolPart('running-todos', 'todowrite', runningState),
      toolPart('failed-todos', 'todowrite', errorState),
    ];

    expect(renderConversation([assistantMessage('assistant-1', hidden)])).toBe('');
    for (const part of hidden) {
      expect(renderToStaticMarkup(React.createElement(PartRenderer, { part }))).toBe('');
    }

    const html = renderConversation([
      assistantMessage('assistant-1', [
        ...hidden,
        toolPart('completed-todos', 'todowrite', completedState),
      ]),
    ]);

    expect(buttons(html)).toEqual([expect.stringContaining('Todos')]);
    expect(buttons(html)[0]).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="alert"');
  });
});
