import { type FilePart, type MessageInfo, type StoredMessage } from '@kilocode/cloud-agent-sdk';
import { type Turn, type TurnPart } from '@kilocode/harness-sdk';

import { type LocalImage } from '@/lib/agent-attachments/local-image';
import { type Question } from './state';

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
 *
 * The model and the time are left blank too, and the details sheet then leaves
 * out their rows. A turn does not say which model wrote it, and a session
 * freezes its model: a switch copies every turn into a session on the new one.
 * Naming the model the chat is on now would credit the new model with what the
 * old one wrote. The copy gives every turn a new identifier, so the time inside
 * that identifier is the time of the switch, not the time the turn was said.
 */

const infoFor = (turn: Turn): MessageInfo =>
  turn.role === 'user'
    ? {
        id: turn.id,
        sessionID: turn.sessionId,
        role: 'user',
        time: { created: 0 },
        agent: 'chat',
        model: { providerID: '', modelID: '' },
      }
    : {
        id: turn.id,
        sessionID: turn.sessionId,
        role: 'assistant',
        time: { created: 0 },
        parentID: '',
        modelID: '',
        providerID: '',
        mode: 'ask',
        agent: 'chat',
        path: { cwd: '', root: '' },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      };

/**
 * What of a turn a reader sees.
 *
 * The words and the images, and only those. A chat offers the clock and, when
 * it has them on, the Kilo MCP server's tools — so a tool part can be a call
 * the model made. That is not what was said: the model's prose is the answer,
 * and a call is working, which would draw as an empty bubble. Thinking is the
 * model's own working too, so neither becomes a bubble.
 */
const said = (turn: Turn) =>
  turn.parts.filter(part => part.kind === 'text' || part.kind === 'image');

type StoredImage = Extract<TurnPart, { kind: 'image' }>;

/**
 * One data URL per image, built once. The URL is the whole image, and the
 * transcript is drawn again for every word of an answer, so it is keyed by the
 * stored part or the question image it came from rather than built on every draw.
 */
const urls = new WeakMap<StoredImage | LocalImage, string>();

function imagePart(
  image: StoredImage | LocalImage,
  id: string,
  turn: Pick<Turn, 'id' | 'sessionId'>
): FilePart {
  let url = urls.get(image);
  if (url === undefined) {
    url = `data:${image.media};base64,${'body' in image ? image.body : image.data}`;
    urls.set(image, url);
  }
  return {
    id,
    sessionID: turn.sessionId,
    messageID: turn.id,
    type: 'file',
    mime: image.media,
    url,
  };
}

function asMessage(turn: Turn): StoredMessage {
  return {
    info: infoFor(turn),
    parts: said(turn).map(part =>
      part.kind === 'image'
        ? imagePart(part, part.id, turn)
        : {
            id: part.id,
            sessionID: turn.sessionId,
            messageID: turn.id,
            type: 'text' as const,
            text: part.body,
          }
    ),
  };
}

/** The identifier of the question that has no answer yet. Its Retry hangs off it. */
export const askedMessageId = (sessionId: string): string => `${sessionId}:asked`;

/** A question that is not in the store yet, as the bubble a person sees. */
function questionMessage(turn: Pick<Turn, 'id' | 'sessionId'>, question: Question): StoredMessage {
  const message = asMessage({
    ...turn,
    role: 'user',
    parts:
      question.text === '' ? [] : [{ id: `${turn.id}:text`, kind: 'text', body: question.text }],
  });
  const images = question.images.map((image, index) =>
    imagePart(image, `${turn.id}:image:${index}`, turn)
  );
  return { ...message, parts: [...images, ...message.parts] };
}

/**
 * The whole transcript, plus what is not in the store yet: the question being
 * answered right now, the answer as it arrives, and anything typed while that
 * was happening.
 *
 * The pending question is drawn from what the app remembers rather than from the
 * store, because the store holds a question and its answer together or neither.
 * It is what the Retry hangs off, and it is on screen from the moment it is
 * asked rather than when its answer lands.
 */
export function asMessages(input: {
  readonly sessionId: string;
  readonly turns: readonly Turn[];
  readonly answering: string;
  readonly asked: string | null;
  /** The images the pending question carries. */
  readonly askedImages: readonly LocalImage[];
  /** Questions typed while an answer was arriving, in the order they go. */
  readonly waiting: readonly Question[];
}): StoredMessage[] {
  const drawn = input.turns.filter(turn => said(turn).length > 0).map(turn => asMessage(turn));
  if (input.asked !== null) {
    const id = askedMessageId(input.sessionId);
    drawn.push(
      questionMessage(
        { id, sessionId: input.sessionId },
        { text: input.asked, images: input.askedImages }
      )
    );
  }
  if (input.answering !== '') {
    drawn.push(
      asMessage({
        id: `${input.sessionId}:answering`,
        sessionId: input.sessionId,
        role: 'assistant',
        parts: [{ id: `${input.sessionId}:answering:text`, kind: 'text', body: input.answering }],
      })
    );
  }
  for (const [index, question] of input.waiting.entries()) {
    drawn.push(
      questionMessage(
        { id: `${input.sessionId}:waiting:${index}`, sessionId: input.sessionId },
        question
      )
    );
  }
  return drawn;
}
