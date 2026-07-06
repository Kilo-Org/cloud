import type { AgentConversationEvent } from './agent-conversation';

type ToolCallEvent = Extract<AgentConversationEvent, { readonly type: 'tool-call' }>;
type ToolResultEvent = Extract<AgentConversationEvent, { readonly type: 'tool-result' }>;

export const isViewportScreenshotValue = (
  value: unknown
): value is { readonly mediaType: string; readonly dataUrl: string } =>
  typeof value === 'object' &&
  value !== null &&
  'dataUrl' in value &&
  typeof value.dataUrl === 'string' &&
  value.dataUrl.startsWith('data:image/') &&
  'mediaType' in value &&
  typeof value.mediaType === 'string';

// The persisted counterpart of a screenshot result: dataUrl stripped, mediaType + note kept.
export const isPersistedScreenshotStub = (
  value: unknown
): value is { readonly mediaType: string; readonly note: string } =>
  typeof value === 'object' &&
  value !== null &&
  !('dataUrl' in value) &&
  'mediaType' in value &&
  typeof value.mediaType === 'string' &&
  'note' in value &&
  typeof value.note === 'string';

const toPersistedToolResult = (
  event: ToolResultEvent,
  toolCall: ToolCallEvent | undefined
): ToolResultEvent => {
  if (
    event.ok &&
    toolCall?.name === 'get_viewport_screenshot' &&
    isViewportScreenshotValue(event.value)
  ) {
    return {
      ...event,
      value: {
        mediaType: event.value.mediaType,
        note: 'Viewport screenshot omitted from persisted history.',
      },
    };
  }

  return event;
};

export const toPersistedConversationEvents = (
  events: AgentConversationEvent[]
): AgentConversationEvent[] => {
  const toolCallsById = new Map<string, ToolCallEvent>();

  return events.map(event => {
    if (event.type === 'tool-call') {
      toolCallsById.set(event.id, event);
      return event;
    }

    return event.type === 'tool-result'
      ? toPersistedToolResult(event, toolCallsById.get(event.toolCallId))
      : event;
  });
};
