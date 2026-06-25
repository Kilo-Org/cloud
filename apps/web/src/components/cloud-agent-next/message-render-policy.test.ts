import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PartRenderer } from './PartRenderer';
import { getAssistantTextContent } from './MessageBubble';
import type { MessageRenderPolicy } from './message-render-policy';
import type { TextPart, ToolPart } from './types';

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => children,
}));

jest.mock('remark-gfm', () => ({
  __esModule: true,
  default: () => null,
}));

const testGlobal = globalThis as typeof globalThis & { React?: typeof React };

beforeAll(() => {
  testGlobal.React = React;
});

afterAll(() => {
  Reflect.deleteProperty(testGlobal, 'React');
});

function textPart(text: string): TextPart {
  return {
    id: 'prt_text',
    sessionID: 'ses_policy',
    messageID: 'msg_policy',
    type: 'text',
    text,
  };
}

function completedToolPart(tool: string): ToolPart {
  return {
    id: 'prt_tool',
    sessionID: 'ses_policy',
    messageID: 'msg_policy',
    type: 'tool',
    callID: 'call_policy',
    tool,
    state: {
      status: 'completed',
      input: { value: 1 },
      output: 'generic result',
      title: 'Generic result',
      metadata: {},
      time: { start: 1, end: 2 },
    },
  };
}

describe('MessageRenderPolicy', () => {
  it('renders a policy node for handled tool parts', () => {
    const policy: MessageRenderPolicy = {
      renderToolPart: part =>
        part.tool === 'custom_policy_tool'
          ? { handled: true, node: React.createElement('div', null, 'Policy handled') }
          : { handled: false },
    };

    const html = renderToStaticMarkup(
      React.createElement(PartRenderer, {
        part: completedToolPart('custom_policy_tool'),
        messageRenderPolicy: policy,
      })
    );

    expect(html).toContain('Policy handled');
    expect(html).not.toContain('custom_policy_tool');
    expect(html).not.toContain('generic result');
  });

  it('falls back to generic tool rendering when a policy does not handle a tool part', () => {
    const policy: MessageRenderPolicy = {
      renderToolPart: () => ({ handled: false }),
    };

    const html = renderToStaticMarkup(
      React.createElement(PartRenderer, {
        part: completedToolPart('custom_unhandled_tool'),
        messageRenderPolicy: policy,
      })
    );

    expect(html).toContain('custom_unhandled_tool');
    expect(html).not.toContain('Policy handled');
  });

  it('transforms assistant text before markdown rendering', () => {
    const policy: MessageRenderPolicy = {
      transformAssistantText: text => text.replace('hidden-token', '[removed]'),
    };

    const html = renderToStaticMarkup(
      React.createElement(PartRenderer, {
        part: textPart('Keep **markdown** but remove hidden-token'),
        messageRenderPolicy: policy,
      })
    );

    expect(html).toContain('[removed]');
    expect(html).toContain('markdown');
    expect(html).not.toContain('hidden-token');
  });

  it('leaves assistant text unchanged without a policy', () => {
    const html = renderToStaticMarkup(
      React.createElement(PartRenderer, {
        part: textPart('Plain **markdown** text'),
      })
    );

    expect(html).toContain('Plain');
    expect(html).toContain('markdown');
  });

  it('uses the assistant text transform for copy text', () => {
    const copyText = getAssistantTextContent(
      [textPart('first'), textPart('second hidden-token')],
      text => text.replace('hidden-token', '[removed]')
    );

    expect(copyText).toBe('first\n\nsecond [removed]');
  });
});
