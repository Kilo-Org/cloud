/* eslint-disable max-expects, jsx-no-new-object-as-prop, max-lines -- test rendering helpers and fixture assertions */
// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { AgentConversationItemView } from './agent-conversation-events';
import type {
  AgentConversationEvent,
  GroupedConversationItem,
} from '@/src/shared/agent-conversation';

// eslint-disable-next-line vitest/prefer-import-in-mock, jest/no-untyped-mock-factory
vi.mock('#imports', () => ({
  browser: { runtime: { sendMessage: vi.fn() }, tabs: { query: vi.fn() } },
  storage: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    watch: vi.fn(() => () => {
      /* No-op */
    }),
  },
}));

type ToolCallEvent = Extract<AgentConversationEvent, { type: 'tool-call' }>;
type ToolResultEvent = Extract<AgentConversationEvent, { type: 'tool-result' }>;

describe('workflow tool exchange rendering', () => {
  const renderToolExchange = (
    toolCall: ToolCallEvent,
    result: ToolResultEvent
  ): ReturnType<typeof render> => {
    const item: GroupedConversationItem = {
      result,
      toolCall,
      type: 'tool-exchange',
    };

    return render(<AgentConversationItemView item={item} />);
  };

  it('renders a successful run_workflow with result and pages visited', () => {
    const toolCall = {
      arguments: { workflowId: 'wf-1' },
      id: 'tc-1',
      name: 'run_workflow' as const,
      tabId: 7,
      type: 'tool-call' as const,
    };
    const result = {
      id: 'tr-1',
      ok: true,
      toolCallId: 'tc-1',
      type: 'tool-result' as const,
      value: {
        pagesVisited: 2,
        result: { count: 42, done: true },
      },
    };

    const { container } = renderToolExchange(toolCall, result);

    expect(container.textContent).toContain('run_workflow');
    expect(container.textContent).toContain('completed');
    expect(container.textContent).toContain('tab 7');
    expect(container.textContent).toContain('workflowId');
    expect(container.textContent).toContain('42');
    expect(container.textContent).toContain('2');
  });

  it('renders a failed run_workflow with error', () => {
    const toolCall = {
      arguments: { workflowId: 'wf-1' },
      id: 'tc-1',
      name: 'run_workflow' as const,
      tabId: 7,
      type: 'tool-call' as const,
    };
    const result = {
      error: 'Workflow not found.',
      id: 'tr-1',
      ok: false,
      toolCallId: 'tc-1',
      type: 'tool-result' as const,
    };

    const { container } = renderToolExchange(toolCall, result);

    expect(container.textContent).toContain('run_workflow');
    expect(container.textContent).toContain('failed');
    expect(container.textContent).toContain('Workflow not found.');
  });

  it('renders search_workflows with empty results', () => {
    const toolCall = {
      arguments: { query: 'checkout' },
      id: 'tc-1',
      name: 'search_workflows' as const,
      tabId: 7,
      type: 'tool-call' as const,
    };
    const result = {
      id: 'tr-1',
      ok: true,
      toolCallId: 'tc-1',
      type: 'tool-result' as const,
      value: { message: 'No workflows for this site.', results: [] },
    };

    const { container } = renderToolExchange(toolCall, result);

    expect(container.textContent).toContain('search_workflows');
    expect(container.textContent).toContain('completed');
  });

  it('renders save_workflow with approval result', () => {
    const toolCall = {
      arguments: {
        description: 'Checkout flow',
        name: 'Checkout',
        scopeOrigin: 'https://shop.example.com',
        script: 'return { done: true };',
      },
      id: 'tc-1',
      name: 'save_workflow' as const,
      tabId: 7,
      type: 'tool-call' as const,
    };
    const result = {
      id: 'tr-1',
      ok: true,
      toolCallId: 'tc-1',
      type: 'tool-result' as const,
      value: { saved: true, workflowId: 'wf-new' },
    };

    const { container } = renderToolExchange(toolCall, result);

    expect(container.textContent).toContain('save_workflow');
    expect(container.textContent).toContain('completed');
    expect(container.textContent).toContain('"saved"');
    expect(container.textContent).toContain('"wf-new"');
  });

  it('renders delete_workflow successfully', () => {
    const toolCall = {
      arguments: { workflowId: 'wf-1' },
      id: 'tc-1',
      name: 'delete_workflow' as const,
      tabId: 7,
      type: 'tool-call' as const,
    };
    const result = {
      id: 'tr-1',
      ok: true,
      toolCallId: 'tc-1',
      type: 'tool-result' as const,
      value: { deleted: true },
    };

    const { container } = renderToolExchange(toolCall, result);

    expect(container.textContent).toContain('delete_workflow');
    expect(container.textContent).toContain('completed');
    expect(container.textContent).toContain('"deleted"');
  });

  it('renders save_memory with result', () => {
    const toolCall = {
      arguments: { note: 'price', text: 'Lowest: $12' },
      id: 'tc-1',
      name: 'save_memory' as const,
      tabId: 7,
      type: 'tool-call' as const,
    };
    const result = {
      id: 'tr-1',
      ok: true,
      toolCallId: 'tc-1',
      type: 'tool-result' as const,
      value: { memoryId: 'mem-1', saved: true },
    };

    const { container } = renderToolExchange(toolCall, result);

    expect(container.textContent).toContain('save_memory');
    expect(container.textContent).toContain('completed');
  });
});

describe('agent tool exchange rendering', () => {
  it('renders a completed agent tool with its title, arguments, and result', () => {
    const toolCall = {
      arguments: { filePath: 'src/auth.ts' },
      id: 'tc-agent-1',
      name: 'read',
      source: 'agent' as const,
      title: 'src/auth.ts',
      type: 'tool-call' as const,
    };
    const result = {
      id: 'tr-agent-1',
      ok: true,
      toolCallId: 'tc-agent-1',
      type: 'tool-result' as const,
      value: 'export const guard = () => true;',
    };
    const item: GroupedConversationItem = {
      result,
      toolCall,
      type: 'tool-exchange',
    };

    const { container } = render(<AgentConversationItemView item={item} />);

    expect(container.textContent).toContain('read');
    expect(container.textContent).toContain('completed');
    expect(container.textContent).toContain('src/auth.ts');
    expect(container.textContent).toContain('Arguments');
    expect(container.textContent).toContain('filePath');
    expect(container.textContent).toContain('Result');
    expect(container.textContent).toContain('export const guard = () => true;');
  });

  it('renders a failed agent tool with the error label and reason', () => {
    const toolCall = {
      arguments: { filePath: 'src/auth.ts' },
      id: 'tc-agent-2',
      name: 'read',
      source: 'agent' as const,
      title: 'src/auth.ts',
      type: 'tool-call' as const,
    };
    const result = {
      error: 'File not found.',
      id: 'tr-agent-2',
      ok: false,
      toolCallId: 'tc-agent-2',
      type: 'tool-result' as const,
    };
    const item: GroupedConversationItem = {
      result,
      toolCall,
      type: 'tool-exchange',
    };

    const { container } = render(<AgentConversationItemView item={item} />);

    expect(container.textContent).toContain('read');
    expect(container.textContent).toContain('failed');
    expect(container.textContent).toContain('Error');
    expect(container.textContent).toContain('File not found.');
  });

  it('renders a running agent tool without a result block', () => {
    const toolCall = {
      arguments: { filePath: 'src/auth.ts' },
      id: 'tc-agent-3',
      name: 'read',
      source: 'agent' as const,
      title: 'src/auth.ts',
      type: 'tool-call' as const,
    };
    const item: GroupedConversationItem = {
      toolCall,
      type: 'tool-exchange',
    };

    const { container } = render(<AgentConversationItemView item={item} />);

    expect(container.textContent).toContain('read');
    expect(container.textContent).toContain('running');
    expect(container.textContent).toContain('Arguments');
    expect(container.textContent).not.toContain('Result');
  });

  it('renders an agent tool image and no result pre', () => {
    const toolCall = {
      arguments: { fullPage: false },
      id: 'tc-agent-4',
      name: 'browser_screenshot',
      source: 'agent' as const,
      title: 'viewport',
      type: 'tool-call' as const,
    };
    const result = {
      id: 'tr-agent-4',
      imageDataUrl:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      ok: true,
      toolCallId: 'tc-agent-4',
      type: 'tool-result' as const,
      value: 'captured',
    };
    const item: GroupedConversationItem = {
      result,
      toolCall,
      type: 'tool-exchange',
    };

    const { container } = render(<AgentConversationItemView item={item} />);

    const image = container.querySelector('img');
    expect(image).not.toBeNull();
    expect(image?.getAttribute('src')).toContain('data:image/png;base64,');
    expect(image?.getAttribute('alt')).toBe('Image produced by browser_screenshot');
    expect(container.textContent).not.toContain('captured');
  });
});
