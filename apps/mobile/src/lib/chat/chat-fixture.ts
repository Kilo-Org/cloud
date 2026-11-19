import { CREDITS_FAILURE_KEY } from './backend-target';
import { newKeptId, rememberAsked, replaceKept } from './pending';
import { releaseChat, startChat } from './registry';
import { type ChatPlace } from './scope';
import { type Displaced } from './state';

/**
 * Development-only chat conversation in each state the chat screen draws from
 * what the device holds. The fixture starts a chat the way the new-chat button
 * does (`startChat`: the SDK session and the app's row), writes the question
 * records a failed or refused send leaves, and releases the chat. The chat route
 * then reopens it through the real registry, the same way a chat reopens after
 * an app restart. Nothing here touches the screen.
 *
 * - `empty`: a started chat with nothing said. The screen opens on the empty
 *   state.
 * - `failed`: a question whose answer failed with a transient cause. Its bubble
 *   shows the failure and Retry.
 * - `credits`: a question the balance refused. Its bubble shows the credits
 *   statement and Add credits, and no Retry, because a re-send meets the same
 *   refusal.
 * - `long`: twelve earlier questions with long Markdown and code, every one
 *   failed or stopped, and a failed question in the slot.
 *
 * Open it through `kiloapp:///dev/chat-fixture/<empty|failed|credits|long>`
 * (`src/app/+native-intent.tsx` → `src/app/(app)/chat-fixture.tsx`). Every
 * open starts a new chat, so the chat list grows by one row per open. A chat
 * this place never recorded is the screen's terminal state and needs no
 * fixture: `kiloapp:///(app)/(tabs)/(4_chat)/chat-fixture-missing`.
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

function keptQuestions(): Displaced[] {
  return Array.from({ length: 12 }, (_, index) => ({
    id: newKeptId(),
    text: `${index + 1}. ${LONG_QUESTION}`,
    images: [],
    model: FIXTURE_MODEL,
    effort: null,
    afterTurns: 0,
    outcome: index % 3 === 0 ? 'stopped' : 'failed',
    failureKey: index % 3 === 0 ? null : 'common.somethingWentWrong',
  }));
}

/** Starts the state's chat, writes its records, and answers the session the chat route opens. */
export async function writeChatFixture(place: ChatPlace, state: ChatFixtureState): Promise<string> {
  const sessionId = await startChat(place, { model: FIXTURE_MODEL, effort: null });
  if (state === 'long') {
    await replaceKept(sessionId, keptQuestions());
  }
  if (state !== 'empty') {
    await rememberAsked(sessionId, {
      text: state === 'long' ? LONG_QUESTION : 'Summarize the open pull requests for me.',
      images: [],
      model: FIXTURE_MODEL,
      effort: null,
      failureKey: state === 'credits' ? CREDITS_FAILURE_KEY : 'common.somethingWentWrong',
    });
  }
  // The registry holds a started chat as it was started. Releasing it makes the
  // route's open read the records back, as a reopen after a restart does.
  await releaseChat(sessionId);
  return sessionId;
}
