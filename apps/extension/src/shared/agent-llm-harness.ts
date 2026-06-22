import type { KiloGatewayChatMessage, KiloGatewayToolDefinition } from './kilo-api-client';
import type { AgentConversationEvent } from './agent-conversation';

type EvalToolCallEvent = Extract<AgentConversationEvent, { readonly type: 'tool-call' }>;

export const EXTENSION_AGENT_SYSTEM_PROMPT = [
  'You are Kilo, an agent running in a browser extension side panel.',
  'You are helping the user with the currently selected browser tab.',
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

const getProviderToolCallId = (toolCall: EvalToolCallEvent): string =>
  toolCall.providerToolCallId ?? toolCall.id;

const toToolResultContent = (
  event: Extract<AgentConversationEvent, { readonly type: 'tool-result' }>
): string =>
  JSON.stringify(
    event.ok
      ? { ok: true, value: event.value }
      : { error: event.error ?? 'Eval failed.', ok: false }
  );

export const buildGatewayMessagesFromEvents = (
  events: AgentConversationEvent[]
): KiloGatewayChatMessage[] => {
  const toolCallsById = new Map<string, EvalToolCallEvent>();
  const messages: KiloGatewayChatMessage[] = [
    { content: EXTENSION_AGENT_SYSTEM_PROMPT, role: 'system' },
  ];

  for (const event of events) {
    switch (event.type) {
      case 'message': {
        messages.push({ content: event.text, role: event.role });
        break;
      }
      case 'tool-call': {
        toolCallsById.set(event.id, event);
        messages.push({
          content: null,
          role: 'assistant',
          tool_calls: [
            {
              function: {
                arguments: JSON.stringify({ code: event.code }),
                name: 'eval',
              },
              id: getProviderToolCallId(event),
              type: 'function',
            },
          ],
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

  return messages;
};
