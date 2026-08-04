/* eslint-disable max-expects, jsx-no-new-object-as-prop -- test rendering helpers and fixture assertions */

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
