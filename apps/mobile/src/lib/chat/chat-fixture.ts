import { encryptedDatabase } from '@/lib/persist/encrypted-kv';

import { CREDITS_FAILURE_KEY } from './backend-target';
import { forgetQuestions, rememberAsked, replaceKept } from './pending';
import { type ChatPlace } from './scope';
import { type Displaced } from './state';
import { rememberChat } from './store';

/**
 * Development-only records for one chat conversation in each state the chat
 * screen draws from what the device holds. A chat reopens from its row in the
 * chats table and from its remembered questions, so this writes those same
 * records for a fixed session and the real `ChatScreen` opens them through the
 * real registry. Nothing here touches the screen.
 *
 * - `empty`: the row only. The screen opens on the empty state.
 * - `failed`: a question whose answer failed with a transient cause. Its bubble
 *   shows the failure and Retry.
 * - `credits`: a question the balance refused. Its bubble shows the credits
 *   statement and Add credits, and no Retry, because a re-send meets the same
 *   refusal.
 * - `long`: twelve earlier questions with long Markdown and code, every one
 *   failed or stopped, and a failed question in the slot.
 *
 * Open it through `kiloapp:///dev/chat-fixture/<empty|failed|credits|long>`
 * (`src/app/+native-intent.tsx` → `src/app/(app)/chat-fixture.tsx`). A chat this
 * place never recorded is the screen's terminal state and needs no fixture:
 * `kiloapp:///(app)/(tabs)/(4_chat)/chat-fixture-missing`.
 */
const CHAT_FIXTURE_STATES = ['empty', 'failed', 'credits', 'long'] as const;

export type ChatFixtureState = (typeof CHAT_FIXTURE_STATES)[number];

export function isChatFixtureState(value: string): value is ChatFixtureState {
  return CHAT_FIXTURE_STATES.some(state => state === value);
}

/** The model the fixture questions were asked of: any id the gateway lists. */
const FIXTURE_MODEL = 'kilo-auto/balanced';

const LONG_QUESTION = [
  '## Release checklist for the mobile app',
  '',
  'Please review the steps below and tell me which ones **can run in parallel**, which ones need a person, and what to check after each step:',
  '',
  '1. Bump the version in `app.config.ts` and the native projects.',
  '2. Build the Android release bundle and the iOS archive.',
  '3. Upload both builds and write the store notes in every catalog language.',
  '',
  '```ts',
  'export function nextVersion(current: string): string {',
  "  const [major, minor, patch] = current.split('.').map(Number);",
  "  return [major, minor, patch + 1].join('.');",
  '}',
  '```',
  '',
  '> The store review can take two days, so the notes must be final before the upload.',
].join('\n');

function chatFixtureSessionId(state: ChatFixtureState): string {
  return `chat-fixture-${state}`;
}

function keptQuestions(): Displaced[] {
  return Array.from({ length: 12 }, (_, index) => ({
    id: `chat-fixture-kept-${index + 1}`,
    text: `${index + 1}. ${LONG_QUESTION}`,
    images: [],
    model: FIXTURE_MODEL,
    effort: null,
    afterTurns: 0,
    outcome: index % 3 === 0 ? 'stopped' : 'failed',
    failureKey: index % 3 === 0 ? null : 'common.somethingWentWrong',
  }));
}

/** Writes the state's records and answers the session the chat route opens. */
export async function writeChatFixture(place: ChatPlace, state: ChatFixtureState): Promise<string> {
  const sessionId = chatFixtureSessionId(state);
  // A rerun starts from the same records, not from what the last open left.
  await forgetQuestions(sessionId);
  rememberChat(await encryptedDatabase(), {
    sessionId,
    scope: place.chatScope,
    at: Date.now(),
  });
  if (state === 'empty') {
    return sessionId;
  }
  if (state === 'long') {
    await replaceKept(sessionId, keptQuestions());
  }
  await rememberAsked(sessionId, {
    text: state === 'long' ? LONG_QUESTION : 'Summarize the open pull requests for me.',
    images: [],
    model: FIXTURE_MODEL,
    effort: null,
    failureKey: state === 'credits' ? CREDITS_FAILURE_KEY : 'common.somethingWentWrong',
  });
  return sessionId;
}
