import { type MessageInfo, type StoredMessage } from '@kilocode/cloud-agent-sdk';
import { type Turn } from '@kilocode/harness-sdk';

/**
 * A harness turn, as the bubble that draws an agent message.
 *
 * `MessageBubble` renders the cloud agent's shape, and every screen in this app
 * that shows a conversation goes through it. A chat is a conversation, so it
 * goes through it too rather than growing a second bubble that drifts from the
 * first.
 *
 * The fields a chat has no answer for are filled with neutral values: there is
 * no path, no cost and no token accounting on the device, and inventing numbers
 * for them would put wrong ones on the screen.
 */

const infoFor = (turn: Turn, model: string): MessageInfo =>
  turn.role === 'user'
    ? {
        id: turn.id,
        sessionID: turn.sessionId,
        role: 'user',
        time: { created: 0 },
        agent: 'chat',
        model: { providerID: 'kilo', modelID: model },
      }
    : {
        id: turn.id,
        sessionID: turn.sessionId,
        role: 'assistant',
        time: { created: 0 },
        parentID: '',
        modelID: model,
        providerID: 'kilo',
        mode: 'ask',
        agent: 'chat',
        path: { cwd: '', root: '' },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      };

/**
 * What of a turn a reader sees.
 *
 * The words, and only the words. A chat offers no tools, so a tool part can
 * only come from a conversation that was moved here from elsewhere; thinking is
 * the model's own working and is not what was said. Both would draw as empty
 * bubbles, so neither becomes one.
 */
const said = (turn: Turn) => turn.parts.filter(part => part.kind === 'text');

function asMessage(turn: Turn, model: string): StoredMessage {
  return {
    info: infoFor(turn, model),
    parts: said(turn).map(part => ({
      id: part.id,
      sessionID: turn.sessionId,
      messageID: turn.id,
      type: 'text' as const,
      text: part.body,
    })),
  };
}

/**
 * The whole transcript, plus what is not in the store yet: the answer arriving
 * now, and a question nothing answered.
 *
 * The pending question is drawn from what the app remembers rather than from the
 * store, because the store holds a question and its answer together or neither.
 * It is what the Retry hangs off.
 */
export function asMessages(input: {
  readonly sessionId: string;
  readonly model: string;
  readonly turns: readonly Turn[];
  readonly answering: string;
  readonly asked: string | null;
}): StoredMessage[] {
  const drawn = input.turns
    .filter(turn => said(turn).length > 0)
    .map(turn => asMessage(turn, input.model));
  if (input.asked !== null) {
    drawn.push(
      asMessage(
        {
          id: `${input.sessionId}:asked`,
          sessionId: input.sessionId,
          role: 'user',
          parts: [{ id: `${input.sessionId}:asked:text`, kind: 'text', body: input.asked }],
        },
        input.model
      )
    );
  }
  if (input.answering !== '') {
    drawn.push(
      asMessage(
        {
          id: `${input.sessionId}:answering`,
          sessionId: input.sessionId,
          role: 'assistant',
          parts: [{ id: `${input.sessionId}:answering:text`, kind: 'text', body: input.answering }],
        },
        input.model
      )
    );
  }
  return drawn;
}
