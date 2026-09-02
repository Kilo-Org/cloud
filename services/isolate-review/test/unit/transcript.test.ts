import { describe, expect, it } from 'vitest';
import type { UIMessage } from 'ai';
import { projectReviewTranscript } from '../../src/transcript';

describe('projectReviewTranscript', () => {
  it('extracts text messages and tool calls from UIMessages', () => {
    const uiMessages = [
      {
        id: 'user-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Review this PR' }],
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        parts: [
          { type: 'text', text: 'Looking at the diff. ' },
          {
            type: 'tool-read',
            toolCallId: 'call-1',
            state: 'output-available',
            input: { path: 'src/foo.ts' },
            output: 'export const foo = 1;',
          },
          { type: 'text', text: 'One finding.' },
        ],
      },
    ] as UIMessage[];

    expect(projectReviewTranscript(uiMessages)).toEqual({
      messages: [
        { id: 'user-1', role: 'user', text: 'Review this PR' },
        { id: 'assistant-1', role: 'assistant', text: 'Looking at the diff. One finding.' },
      ],
      toolCalls: [
        {
          messageId: 'assistant-1',
          toolCallId: 'call-1',
          toolName: 'read',
          state: 'output-available',
          input: { path: 'src/foo.ts' },
          output: 'export const foo = 1;',
        },
      ],
    });
  });

  it('keeps failed tool calls and dynamic tools', () => {
    const uiMessages = [
      {
        id: 'assistant-1',
        role: 'assistant',
        parts: [
          {
            type: 'dynamic-tool',
            toolName: 'pr_diff',
            toolCallId: 'call-2',
            state: 'output-error',
            input: { pullNumber: 1 },
            errorText: 'GitHub API returned 404',
          },
        ],
      },
    ] as UIMessage[];

    expect(projectReviewTranscript(uiMessages).toolCalls).toEqual([
      {
        messageId: 'assistant-1',
        toolCallId: 'call-2',
        toolName: 'pr_diff',
        state: 'output-error',
        input: { pullNumber: 1 },
        errorText: 'GitHub API returned 404',
      },
    ]);
  });
});
