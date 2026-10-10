import type {
  ControlPlaneAnswerReply,
  ControlPlanePromptPayload,
} from '../../shared/control-plane-protocol.js';
import type { SessionMessage } from './messages.js';

/**
 * The user text for an answer that continues the chat as a new message. A
 * question answer is the selected labels; a rejection and a permission
 * decision become a short instruction. Returns null when the reply carries
 * nothing to send (an empty selection).
 */
export function answerPromptText(reply: ControlPlaneAnswerReply): string | null {
  switch (reply.action) {
    case 'answer': {
      const text = reply.answers
        .map(group => group.join(', '))
        .filter(group => group.length > 0)
        .join('\n');
      return text.length > 0 ? text : null;
    }
    case 'reject':
      return 'Reject the pending request.';
    case 'permission':
      switch (reply.response) {
        case 'always':
          return 'Always allow.';
        case 'once':
          return 'Allow once.';
        case 'reject':
          return 'Deny.';
      }
  }
}

/**
 * Spec §5: an answer for a turn that already settled becomes a new message. The
 * new message continues the session's last turn, so it reuses that intent's
 * agent, model and finalization and only its content is the answer. A command
 * intent carries no model, so `fallbackModel` (the session metadata's model)
 * supplies it. Returns null when neither the intent nor the fallback has a
 * model to build a prompt turn from.
 */
export function answerMessageIntent(
  messages: readonly SessionMessage[],
  reply: ControlPlaneAnswerReply,
  messageId: string,
  fallbackModel?: string
): ControlPlanePromptPayload | null {
  const last = messages[messages.length - 1];
  if (last === undefined) return null;
  const prompt = answerPromptText(reply);
  if (prompt === null) return null;
  const { mode, model, variant } = last.intent.agent;
  const resolvedModel = model ?? fallbackModel;
  if (resolvedModel === undefined) return null;
  return {
    messageId,
    turn: { type: 'prompt', prompt },
    agent: { mode, model: resolvedModel, ...(variant === undefined ? {} : { variant }) },
    ...(last.intent.finalization === undefined ? {} : { finalization: last.intent.finalization }),
  };
}
