import { describe, expect, it } from 'vitest';
import {
  isKiloBrowserToolCallName,
  isRemoteMcpToolName,
  isWebMcpToolCallEvent,
  isWorkflowToolName,
  toBrowserToolCallEvents,
  toDangerousToolCallEvents,
  toWebMcpToolCallEvents,
  toWorkflowToolCallEvent,
  toWorkflowToolCallEvents,
} from './agent-tool-call-events';
import type { KiloGatewayToolCallRequest } from '@/src/shared/kilo-api-client';
import type { WebMcpToolRoute } from '@/src/shared/web-mcp-tools';

describe('workflow tool call events', () => {
  it('recognizes the first three workflow tool names', () => {
    expect(isWorkflowToolName('search_workflows')).toBe(true);
    expect(isWorkflowToolName('get_workflow')).toBe(true);
    expect(isWorkflowToolName('save_workflow')).toBe(true);
  });

  it('recognizes the last three workflow tool names', () => {
    expect(isWorkflowToolName('save_memory')).toBe(true);
    expect(isWorkflowToolName('run_workflow')).toBe(true);
    expect(isWorkflowToolName('delete_workflow')).toBe(true);
  });

  it('does not recognize safe tool names as workflow names', () => {
    expect(isWorkflowToolName('kilo_browser_click')).toBe(false);
    expect(isWorkflowToolName('get_page_snapshot')).toBe(false);
    expect(isWorkflowToolName('search_memories')).toBe(false);
    expect(isWorkflowToolName('mcp_test_tool')).toBe(false);
  });

  it('converts a single workflow tool call from gateway request', () => {
    const request: KiloGatewayToolCallRequest = {
      arguments: { workflowId: 'wf-1' },
      id: 'call-1',
      name: 'run_workflow',
    };
    const event = toWorkflowToolCallEvent(request, 7);

    expect(event).toBeDefined();
    expect(event?.type).toBe('tool-call');
    expect(event?.name).toBe('run_workflow');
    expect(event?.tabId).toBe(7);
    expect(event?.arguments).toStrictEqual({ workflowId: 'wf-1' });
  });

  it('returns undefined for non-workflow tool names', () => {
    const request: KiloGatewayToolCallRequest = {
      arguments: {},
      id: 'call-1',
      name: 'kilo_browser_snapshot',
    };
    const event = toWorkflowToolCallEvent(request, 7);

    expect(event).toBeUndefined();
  });

  it('converts multiple workflow tool calls', () => {
    const requests: KiloGatewayToolCallRequest[] = [
      { arguments: { query: 'checkout' }, id: 'call-1', name: 'search_workflows' },
      { arguments: { workflowId: 'wf-1' }, id: 'call-2', name: 'get_workflow' },
    ];

    const events = toWorkflowToolCallEvents(requests, 7);

    expect(events).toHaveLength(2);
    expect(events[0]?.name).toBe('search_workflows');
    expect(events[0]?.arguments).toStrictEqual({ query: 'checkout' });
    expect(events[1]?.name).toBe('get_workflow');
    expect(events[1]?.arguments).toStrictEqual({ workflowId: 'wf-1' });
  });

  it('routes all six workflow names through the dangerous event converter', () => {
    const requests: KiloGatewayToolCallRequest[] = [
      { arguments: { query: 'checkout' }, id: 'call-s', name: 'search_workflows' },
      { arguments: { workflowId: 'wf-1' }, id: 'call-g', name: 'get_workflow' },
      {
        arguments: {
          description: 'Complete checkout',
          name: 'Checkout flow',
          scopeOrigin: 'https://shop.example.com',
          script: 'return { done: true, result: 42 };',
        },
        id: 'call-sv',
        name: 'save_workflow',
      },
      {
        arguments: { note: 'price', text: 'Lowest price: $12' },
        id: 'call-sm',
        name: 'save_memory',
      },
      { arguments: { workflowId: 'wf-1' }, id: 'call-r', name: 'run_workflow' },
      { arguments: { workflowId: 'wf-1' }, id: 'call-d', name: 'delete_workflow' },
    ];

    const events = toDangerousToolCallEvents(requests, 7);

    const eventNames = events.map(event => event.name);
    expect(eventNames).toStrictEqual([
      'search_workflows',
      'get_workflow',
      'save_workflow',
      'save_memory',
      'run_workflow',
      'delete_workflow',
    ]);
  });

  it('does not confuse workflow names with remote MCP names', () => {
    expect(isRemoteMcpToolName('search_workflows')).toBe(false);
    expect(isRemoteMcpToolName('run_workflow')).toBe(false);
    expect(isRemoteMcpToolName('mcp_test_search_workflows')).toBe(true);
  });
});

describe('kilo browser tool call events', () => {
  it('recognizes only kilo_browser_ names', () => {
    expect(isKiloBrowserToolCallName('kilo_browser_click')).toBe(true);
    expect(isKiloBrowserToolCallName('kilo_browser_snapshot')).toBe(true);
    expect(isKiloBrowserToolCallName('browser_click')).toBe(false);
    expect(isKiloBrowserToolCallName('get_page_snapshot')).toBe(false);
    expect(isKiloBrowserToolCallName('mcp_test_tool')).toBe(false);
  });

  it('accepts a kilo_browser_ name in the gateway tool union', () => {
    const request: KiloGatewayToolCallRequest = {
      arguments: { element: 'Save', ref: 'e5' },
      id: 'call-click',
      name: 'kilo_browser_click',
    };

    expect(request.name).toBe('kilo_browser_click');
  });

  it('carries the upstream arguments verbatim in dangerous mode', () => {
    const nestedArguments = {
      element: 'Save',
      nested: { deep: { value: [1, 2, 3] } },
      ref: 'e5',
    };

    const events = toBrowserToolCallEvents(
      [{ arguments: nestedArguments, id: 'call-click', name: 'kilo_browser_click' }],
      7,
      'dangerous'
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      arguments: nestedArguments,
      name: 'kilo_browser_click',
      providerToolCallId: 'call-click',
      tabId: 7,
      type: 'tool-call',
    });
  });

  it('exposes a read-only browser tool in safe mode', () => {
    const events = toBrowserToolCallEvents(
      [{ arguments: {}, id: 'call-snapshot', name: 'kilo_browser_snapshot' }],
      7,
      'safe'
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      arguments: {},
      name: 'kilo_browser_snapshot',
      providerToolCallId: 'call-snapshot',
      tabId: 7,
      type: 'tool-call',
    });
  });

  it('refuses a non-read-only browser tool in safe mode instead of dropping it', () => {
    const events = toBrowserToolCallEvents(
      [{ arguments: { element: 'Save', ref: 'e5' }, id: 'call-click', name: 'kilo_browser_click' }],
      7,
      'safe'
    );

    expect(events).toStrictEqual([
      expect.objectContaining({
        error:
          'kilo_browser_click is not read-only: safe mode exposes only the Playwright MCP tools the upstream server marks with readOnlyHint, and this tool does not carry it. Switch to danger mode to run it.',
        ok: false,
        toolCallId: 'call-click',
        type: 'tool-result',
      }),
    ]);
  });

  it('ignores names that are not browser tool calls', () => {
    expect(
      toBrowserToolCallEvents(
        [{ arguments: {}, id: 'call-1', name: 'run_workflow' }],
        7,
        'dangerous'
      )
    ).toStrictEqual([]);
  });
});

describe('web MCP tool call events', () => {
  const route: WebMcpToolRoute = {
    definitionSignature: '["search","Search","Find","https://example.com",{"type":"object"}]',
    documentId: 'doc-1',
    origin: 'https://example.com',
    tabId: 7,
  };

  it('emits a WebMCP event for a routed name', () => {
    const request = {
      arguments: { query: 'kilo' },
      id: 'call-1',
      name: 'search',
    };

    const events = toWebMcpToolCallEvents([request], new Map([['search', route]]));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      arguments: { query: 'kilo' },
      definitionSignature: route.definitionSignature,
      documentId: 'doc-1',
      name: 'search',
      providerToolCallId: 'call-1',
      tabId: 7,
      type: 'tool-call',
      webMcpOrigin: 'https://example.com',
    });
  });

  it('skips an unrouted name', () => {
    const request = {
      arguments: { query: 'kilo' },
      id: 'call-1',
      name: 'unrouted',
    };

    const events = toWebMcpToolCallEvents([request], new Map([['search', route]]));

    expect(events).toStrictEqual([]);
  });

  it('discriminates a WebMCP event by webMcpOrigin', () => {
    const webMcpCall = { name: 'search', webMcpOrigin: 'https://example.com' };
    const plainCall = { name: 'search' };
    const workflowCall = { name: 'run_workflow' };

    expect(isWebMcpToolCallEvent(webMcpCall)).toBe(true);
    expect(isWebMcpToolCallEvent(plainCall)).toBe(false);
    expect(isWebMcpToolCallEvent(workflowCall)).toBe(false);
  });
});
