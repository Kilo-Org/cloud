import { getToolName, isToolUIPart, type UIMessage } from 'ai';

export type ReviewTranscriptMessage = {
  id: string;
  role: UIMessage['role'];
  text: string;
};

export type ReviewTranscriptToolCall = {
  messageId: string;
  toolCallId: string;
  toolName: string;
  state: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

export type ReviewTranscriptResponse = {
  runId: string;
  messages: ReviewTranscriptMessage[];
  toolCalls: ReviewTranscriptToolCall[];
};

function textFromParts(parts: UIMessage['parts']): string {
  return parts
    .filter(
      (part): part is Extract<(typeof parts)[number], { type: 'text' }> => part.type === 'text'
    )
    .map(part => part.text)
    .join('');
}

export function projectReviewTranscript(uiMessages: UIMessage[]): {
  messages: ReviewTranscriptMessage[];
  toolCalls: ReviewTranscriptToolCall[];
} {
  const messages: ReviewTranscriptMessage[] = [];
  const toolCalls: ReviewTranscriptToolCall[] = [];

  for (const message of uiMessages) {
    messages.push({
      id: message.id,
      role: message.role,
      text: textFromParts(message.parts),
    });

    for (const part of message.parts) {
      if (!isToolUIPart(part)) continue;
      const toolCall: ReviewTranscriptToolCall = {
        messageId: message.id,
        toolCallId: part.toolCallId,
        toolName: getToolName(part),
        state: part.state,
      };
      if (part.input !== undefined) toolCall.input = part.input;
      if (part.output !== undefined) toolCall.output = part.output;
      if (part.errorText !== undefined) toolCall.errorText = part.errorText;
      toolCalls.push(toolCall);
    }
  }

  return { messages, toolCalls };
}
