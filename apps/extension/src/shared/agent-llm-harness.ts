import type { KiloGatewayChatMessage, KiloGatewayToolDefinition } from './kilo-api-client';
import type { AgentConversationEvent } from './agent-conversation';

type ToolCallEvent = Extract<AgentConversationEvent, { readonly type: 'tool-call' }>;
type MessageEvent = Extract<AgentConversationEvent, { readonly type: 'message' }>;

export const EXTENSION_AGENT_SYSTEM_PROMPT = [
  'You are Kilo, an agent running in a browser extension side panel.',
  'You are helping the user with the currently selected browser tab.',
  'In safe mode, you have read-only page tools for snapshots, element details, and text search.',
  'Safe mode tools cannot click, type, navigate, submit forms, read storage, read cookies, or run model-authored JavaScript.',
  'In dangerous mode, you have exactly one tool: eval.',
  'The eval tool runs JavaScript in the selected browser tab. Its code argument is inserted inside an async function body.',
  'Always return a JSON-serializable value from eval when you need to inspect or change the page.',
  'Use eval for page inspection, clicking, typing, DOM reads, DOM writes, and other webpage control.',
  'Do not claim that an action succeeded until the tool result confirms it.',
  'Do not put markdown fences in eval code.',
].join('\n');

export const createEvalToolDefinition = (): KiloGatewayToolDefinition => ({
  function: {
    description:
      'Run JavaScript in the selected browser tab. The code is inserted inside an async function body, so use return for the value Kilo should read.',
    name: 'eval',
    parameters: {
      additionalProperties: false,
      properties: {
        code: {
          description:
            'JavaScript async function body to run in the selected tab. Return a JSON-serializable value. Do not wrap it in markdown fences.',
          type: 'string',
        },
      },
      required: ['code'],
      type: 'object',
    },
  },
  type: 'function',
});

export const createSafeToolDefinitions = (): KiloGatewayToolDefinition[] => [
  {
    function: {
      description:
        'Read a bounded, sanitized snapshot of the selected browser tab. Returns title, URL, visible text, headings, links, controls, and opaque element ids.',
      name: 'get_page_snapshot',
      parameters: {
        additionalProperties: false,
        properties: {},
        type: 'object',
      },
    },
    type: 'function',
  },
  {
    function: {
      description:
        'Read more details for an element id returned by get_page_snapshot or find_in_page.',
      name: 'get_element_details',
      parameters: {
        additionalProperties: false,
        properties: {
          elementId: {
            description: 'Opaque element id from a previous safe-mode page snapshot.',
            type: 'string',
          },
        },
        required: ['elementId'],
        type: 'object',
      },
    },
    type: 'function',
  },
  {
    function: {
      description:
        'Search the selected tab snapshot for visible text. Returns matching safe snapshot nodes.',
      name: 'find_in_page',
      parameters: {
        additionalProperties: false,
        properties: {
          query: {
            description: 'Plain text to search for in the selected tab snapshot.',
            type: 'string',
          },
        },
        required: ['query'],
        type: 'object',
      },
    },
    type: 'function',
  },
];

const getProviderToolCallId = (toolCall: ToolCallEvent): string =>
  toolCall.providerToolCallId ?? toolCall.id;

const toToolResultContent = (
  event: Extract<AgentConversationEvent, { readonly type: 'tool-result' }>
): string =>
  JSON.stringify(
    event.ok
      ? { ok: true, value: event.value }
      : { error: event.error ?? 'Eval failed.', ok: false }
  );

const getConsecutiveToolCalls = (
  events: AgentConversationEvent[],
  startIndex: number
): ToolCallEvent[] => {
  const toolCalls: ToolCallEvent[] = [];

  for (let index = startIndex; index < events.length; index += 1) {
    const toolCall = events[index];

    if (toolCall === undefined || toolCall.type !== 'tool-call') {
      break;
    }

    toolCalls.push(toolCall);
  }

  return toolCalls;
};

const getGatewayMessageText = (event: MessageEvent): string =>
  event.role === 'user' && event.systemEnvironment !== undefined
    ? `${event.text}\n\n${event.systemEnvironment}`
    : event.text;

export const buildGatewayMessagesFromEvents = (
  events: AgentConversationEvent[]
): KiloGatewayChatMessage[] => {
  const toolCallsById = new Map<string, ToolCallEvent>();
  const messages: KiloGatewayChatMessage[] = [
    { content: EXTENSION_AGENT_SYSTEM_PROMPT, role: 'system' },
  ];

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];

    if (event !== undefined) {
      switch (event.type) {
        case 'message': {
          messages.push({ content: getGatewayMessageText(event), role: event.role });
          break;
        }
        case 'thinking': {
          break;
        }
        case 'tool-call': {
          const toolCalls = getConsecutiveToolCalls(events, index);
          for (const toolCall of toolCalls) {
            toolCallsById.set(toolCall.id, toolCall);
          }

          index += toolCalls.length - 1;
          messages.push({
            content: null,
            role: 'assistant',
            tool_calls: toolCalls.map(toolCall => ({
              function: {
                arguments:
                  toolCall.name === 'eval'
                    ? JSON.stringify({ code: toolCall.code })
                    : JSON.stringify({
                        ...(toolCall.elementId === undefined
                          ? {}
                          : { elementId: toolCall.elementId }),
                        ...(toolCall.query === undefined ? {} : { query: toolCall.query }),
                      }),
                name: toolCall.name,
              },
              id: getProviderToolCallId(toolCall),
              type: 'function',
            })),
          });
          break;
        }
        case 'tool-result': {
          const toolCall = toolCallsById.get(event.toolCallId);

          if (toolCall !== undefined) {
            messages.push({
              content: toToolResultContent(event),
              role: 'tool',
              tool_call_id: getProviderToolCallId(toolCall),
            });
          }
          break;
        }
      }
    }
  }

  return messages;
};
