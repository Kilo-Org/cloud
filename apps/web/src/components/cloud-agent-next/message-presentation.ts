import type { PreparationAttempt } from '@kilocode/cloud-agent-sdk';
import type { Part, StoredMessage, ToolPart } from './types';
import { isAssistantMessage, shouldRenderReasoningPart } from './types';

export function groupConversationMessages(
  messages: StoredMessage[],
  preparationByMessageId: ReadonlyMap<string, readonly PreparationAttempt[]>
): StoredMessage[][] {
  const groups: StoredMessage[][] = [];

  for (const message of messages) {
    const previousGroup = groups.at(-1);
    const previous = previousGroup?.at(-1);
    if (
      previousGroup &&
      previous &&
      isAssistantMessage(previous.info) &&
      isAssistantMessage(message.info) &&
      previous.info.sessionID === message.info.sessionID &&
      previous.info.parentID === message.info.parentID &&
      previous.info.error == null &&
      message.info.error == null &&
      !preparationByMessageId.get(previous.info.id)?.length &&
      !preparationByMessageId.get(message.info.id)?.length
    ) {
      previousGroup.push(message);
    } else {
      groups.push([message]);
    }
  }

  return groups;
}

export function shouldRenderToolPart(part: ToolPart): boolean {
  if (part.tool === 'plan_enter' || part.tool === 'plan_exit' || part.tool === 'todoread') {
    return false;
  }
  return part.tool !== 'todowrite' || part.state.status === 'completed';
}

export function getVisibleAssistantParts(parts: Part[]): Part[] {
  return parts.filter(part => {
    switch (part.type) {
      case 'step-start':
      case 'step-finish':
      case 'patch':
        return false;
      case 'reasoning':
        return shouldRenderReasoningPart(part);
      case 'text':
        return part.text.trim() !== '';
      case 'tool':
        return shouldRenderToolPart(part);
      default:
        return true;
    }
  });
}
