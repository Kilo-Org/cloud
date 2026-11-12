/* eslint-disable max-expects, jsx-no-new-object-as-prop, max-lines -- test rendering helpers and fixture assertions */
// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { AgentConversationItemView } from './agent-conversation-events';
import {
  createAssistantMessage,
  createConversationErrorEvent,
  createToolCall,
} from '@/src/shared/agent-conversation';
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
    result: ToolResultEvent,
    tabLabels?: ReadonlyMap<number, string>
  ): ReturnType<typeof render> => {
    const item: GroupedConversationItem = {
      result,
      toolCall,
      type: 'tool-exchange',
    };

    return render(<AgentConversationItemView item={item} tabLabels={tabLabels} />);
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

    const { container } = renderToolExchange(toolCall, result, new Map([[7, 'Kilo - Wikipedia']]));

    expect(container.textContent).toContain('run_workflow');
    expect(container.textContent).toContain('completed');
    expect(container.textContent).toContain('Kilo - Wikipedia');
    expect(container.textContent).not.toContain('tab 7');
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

describe('playwright browser tool exchange rendering', () => {
  it('renders the Playwright title for a kilo_browser_ call', () => {
    const toolCall = createToolCall({
      arguments: { url: 'https://example.com' },
      name: 'kilo_browser_navigate',
      tabId: 7,
    });
    const result = {
      id: 'tr-1',
      ok: true,
      toolCallId: toolCall.id,
      type: 'tool-result' as const,
      value: 'Example Domain',
    };
    const item: GroupedConversationItem = {
      result,
      toolCall,
      type: 'tool-exchange',
    };

    const { container } = render(
      <AgentConversationItemView item={item} tabLabels={new Map([[7, 'Example Domain']])} />
    );

    expect(container.textContent).toContain('Navigate to a URL');
    expect(container.textContent).toContain('completed');
    expect(container.textContent).toContain('Example Domain');
    expect(container.textContent).not.toContain('tab 7');
    expect(container.textContent).toContain('Arguments');
    expect(container.textContent).toContain('https://example.com');
    expect(container.textContent).toContain('Example Domain');
  });

  it('renders a browser screenshot image and no result pre', () => {
    const toolCall = createToolCall({
      arguments: { scale: 'css' },
      name: 'kilo_browser_take_screenshot',
      tabId: 7,
    });
    const result = {
      id: 'tr-1',
      ok: true,
      toolCallId: toolCall.id,
      type: 'tool-result' as const,
      value: {
        dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
        mediaType: 'image/png',
      },
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
    expect(image?.getAttribute('alt')).toBe('Image produced by kilo_browser_take_screenshot');
    expect(container.textContent).toContain('Take a screenshot');
    expect(container.textContent).not.toContain('iVBORw0KGgo=');
  });
});

describe('web MCP tool exchange rendering', () => {
  it('renders the tool name as the title and the origin as the subtitle', () => {
    const toolCall = {
      arguments: { query: 'kilo' },
      definitionSignature: '["search","Search","Find","https://example.com",{"type":"object"}]',
      documentId: 'doc-1',
      id: 'tc-webmcp-1',
      name: 'search',
      providerToolCallId: 'call_webmcp_1',
      tabId: 7,
      type: 'tool-call' as const,
      webMcpOrigin: 'https://example.com',
    };
    const result = {
      id: 'tr-webmcp-1',
      ok: true,
      toolCallId: 'tc-webmcp-1',
      type: 'tool-result' as const,
      value: { hits: 2 },
    };
    const item: GroupedConversationItem = {
      result,
      toolCall,
      type: 'tool-exchange',
    };

    const { container } = render(<AgentConversationItemView item={item} />);

    expect(container.textContent).toContain('search');
    expect(container.textContent).toContain('https://example.com');
    expect(container.textContent).toContain('completed');
    expect(container.textContent).toContain('Arguments');
    expect(container.textContent).toContain('query');
    expect(container.textContent).not.toContain('tab 7');
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

describe('assistant markdown links', () => {
  const renderAssistantText = (text: string): ReturnType<typeof render> =>
    render(
      <AgentConversationItemView item={{ event: createAssistantMessage(text), type: 'event' }} />
    );

  it('opens a web link elsewhere instead of navigating the panel', () => {
    const { container } = renderAssistantText('[Example](https://example.com/path)');

    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://example.com/path');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('keeps a mailto link and refuses any other scheme', () => {
    const mail = renderAssistantText('[Mail](mailto:help@kilo.ai)');
    expect(mail.container.querySelector('a')?.getAttribute('href')).toBe('mailto:help@kilo.ai');

    const script = renderAssistantText('[Run](javascript:alert(1))');
    expect(script.container.querySelector('a')).toBeNull();
    expect(script.container.textContent).toContain('Run');
  });
});

describe('running tool call rendering', () => {
  it('renders the tool row in a running state while the call is in flight', () => {
    const toolCall = createToolCall({ arguments: {}, name: 'kilo_browser_snapshot', tabId: 7 });

    const { container } = render(
      <AgentConversationItemView item={{ toolCall, type: 'tool-exchange' }} />
    );

    expect(container.querySelector('details')).not.toBeNull();
    expect(container.textContent).toContain('Page snapshot');
    expect(container.textContent).toContain('running');
    // Nothing to report yet, and no empty Arguments block for a call that takes none.
    expect(container.textContent).not.toContain('Arguments');
    expect(container.textContent).not.toContain('Result');
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('hides the Arguments block when the call takes no arguments', () => {
    const toolCall = createToolCall({ arguments: {}, name: 'kilo_browser_snapshot', tabId: 7 });
    const result = {
      id: 'tr-1',
      ok: true,
      toolCallId: toolCall.id,
      type: 'tool-result' as const,
      value: 'Snapshot text',
    };

    const { container } = render(
      <AgentConversationItemView item={{ result, toolCall, type: 'tool-exchange' }} />
    );

    expect(container.textContent).toContain('completed');
    expect(container.textContent).not.toContain('Arguments');
    expect(container.textContent).toContain('Snapshot text');
  });
});

describe('error notice rendering', () => {
  it('shows the failure as an alert and retries the turn on Retry', () => {
    const event = createConversationErrorEvent({ retry: 'turn', title: 'The server is busy.' });
    const onRetryError = vi.fn();

    const { container, getByRole } = render(
      <AgentConversationItemView item={{ event, type: 'event' }} onRetryError={onRetryError} />
    );

    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).toContain('The server is busy.');
    fireEvent.click(getByRole('button', { name: 'Retry' }));
    expect(onRetryError).toHaveBeenCalledWith(event);
  });

  it('offers the credits link instead of Retry when repeating cannot help', () => {
    const event = createConversationErrorEvent({
      action: { href: 'https://app.kilo.ai/credits', label: 'Add credits' },
      detail: 'Your balance is zero.',
      title: "You're out of credits.",
    });

    const { getByRole, queryByRole } = render(
      <AgentConversationItemView item={{ event, type: 'event' }} onRetryError={vi.fn()} />
    );

    expect(queryByRole('button', { name: 'Retry' })).toBeNull();
    expect(getByRole('link', { name: 'Add credits' }).getAttribute('target')).toBe('_blank');
  });
});
