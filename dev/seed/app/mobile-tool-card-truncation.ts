import { execFileSync } from 'node:child_process';

import { cli_sessions_v2, kilocode_users } from '@kilocode/db/schema';
import { signKiloToken } from '@kilocode/worker-utils';
import { and, eq } from 'drizzle-orm';

import type { SeedResult } from '../index';
import { assertLocalSeedDatabase, getSeedDb } from '../lib/db';
import {
  buildAssistantMessageItem,
  buildSessionItem,
  buildToolPartItem,
  buildUserMessageItem,
  parseSessionIngestServiceStatus,
  type SessionIngestItem,
} from '../lib/mobile-sheet-fixtures';
import { seedTokenSigningParams } from '../lib/token-signing';

export const usage = '<email>';

// 30 chars: ses_ + 8 filler + 18.
export const SESSION_ID = 'ses_00000000ToolCardTrunc00001';
export const SESSION_TITLE = 'Tool card truncation fixture';

const PROMPT_ID = 'msgTruncationUser000001';
// One assistant message per tool row: a short text part before the call flushes
// the transcript's condensed run, so each of the four rows renders alone.
const FIRST_ASSISTANT_ID = 'msgTruncationAsst000001';
const SECOND_ASSISTANT_ID = 'msgTruncationAsst000002';
const THIRD_ASSISTANT_ID = 'msgTruncationAsst000003';
const FOURTH_ASSISTANT_ID = 'msgTruncationAsst000004';

const PROMPT_PART = 'prtTruncationPrompt001';
const FIRST_TEXT_PART = 'prtTruncationText00001';
const SECOND_TEXT_PART = 'prtTruncationText00002';
const THIRD_TEXT_PART = 'prtTruncationText00003';
const FOURTH_TEXT_PART = 'prtTruncationText00004';
// The page stores parts in part-id order, so each tool id sorts after its
// message's `prtTruncationText…` id: 'o' > 'e' at the 15th character.
const FAMILY_PART = 'prtTruncationToolFamily1';
const CONJUNCT_PART = 'prtTruncationToolConjunct';
const WEBSEARCH_PART = 'prtTruncationToolSearch1';
const TASK_PART = 'prtTruncationToolTask001';
const EXPECTED = [
  PROMPT_PART,
  FIRST_TEXT_PART,
  FAMILY_PART,
  SECOND_TEXT_PART,
  CONJUNCT_PART,
  THIRD_TEXT_PART,
  WEBSEARCH_PART,
  FOURTH_TEXT_PART,
  TASK_PART,
];

// Each message completes before the next starts, so the transcript orders the
// four rows and never groups them into one condensed run.
const T0 = 1_700_900_000_000;
const FIRST_CREATED = T0 + 1_000;
const FIRST_DONE = T0 + 4_000;
const SECOND_CREATED = T0 + 5_000;
const SECOND_DONE = T0 + 8_000;
const THIRD_CREATED = T0 + 9_000;
const THIRD_DONE = T0 + 13_000;
const FOURTH_CREATED = T0 + 14_000;
const FOURTH_DONE = T0 + 18_000;

const FIRST_START = FIRST_CREATED + 1_000;
const FIRST_END = FIRST_CREATED + 2_500;
const SECOND_START = SECOND_CREATED + 1_000;
const SECOND_END = SECOND_CREATED + 1_800;
const THIRD_START = THIRD_CREATED + 1_000;
const THIRD_END = THIRD_CREATED + 3_900;
const FOURTH_START = FOURTH_CREATED + 1_000;
const FOURTH_END = FOURTH_CREATED + 3_800;

const PROMPT_TEXT = 'Run the release checks and show me the command lines.';
const FIRST_TEXT = 'First I write the family photo to a temporary file.';
const SECOND_TEXT = 'Next I probe the tenant cache keys.';
const THIRD_TEXT = 'Now I search for the release notes.';
const FOURTH_TEXT = 'Last I summarise the release checklist.';

// Each tool row truncates its label to 60 UTF-16 code units (`truncateText` in
// tool-card-display.ts), so every label below puts one grapheme cluster exactly
// across that cut. The ASCII prefix of each label is counted in code units, and
// each label sits in its own assistant message, so all four rows show the cut.
//
// 1. The bash row shows `echo "family-…-241👨‍👩‍👧`: `echo "` (6) + 53 ASCII =
//    59, so the ZWJ family emoji starts at index 59 and a 60-unit slice keeps
//    its high surrogate and drops the low one.
const FAMILY_SLUG = 'family-portrait-picnic-reunion-garden-photo-album-241';
const FAMILY_EMOJI = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
const BASH_FAMILY_COMMAND = `echo "${FAMILY_SLUG}${FAMILY_EMOJI}" > /tmp/family.txt`;

// 2. The second bash row shows `node scripts/…kilo-org-24क्ष`: 58 ASCII, so
//    the Devanagari conjunct starts at index 58 and the cut keeps the consonant
//    and the virama and drops the base consonant they attach to.
const CONJUNCT_PREFIX = 'node scripts/probe-tenant-cache-keys --tenant="kilo-org-24';
const DEVANAGARI_CLUSTER = '\u0915\u094D\u0937';
const BASH_CONJUNCT_COMMAND = `${CONJUNCT_PREFIX}${DEVANAGARI_CLUSTER}" --dry-run`;

// 3. The search row shows `mobile agent …fixture case🇷🇸`: 58 ASCII, so the
//    regional-indicator flag starts at index 58 and the cut keeps exactly one of
//    its two indicators.
const QUERY_PREFIX = 'mobile agent chat tool card labels truncation fixture case';
const REGIONAL_FLAG = '\u{1F1F7}\u{1F1F8}';
const WEBSEARCH_QUERY = `${QUERY_PREFIX}${REGIONAL_FLAG} release notes`;

// 4. The task row shows `Summarise …team café`: 57 ASCII, so `e` sits at index
//    57 and its combining acute at 58, and the cut keeps the letter and drops
//    the accent.
const PROMPT_PREFIX = 'Summarise the release checklist for the whole QA team caf';
const COMBINING_ACUTE = '\u0301';
const TASK_PROMPT = `${PROMPT_PREFIX}e${COMBINING_ACUTE} and the rest of the sentence`;

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:mobile-tool-card-truncation ${usage}`);
  console.log('');
  console.log('Seeds one read-only session through the local cloudflare-session-ingest');
  console.log('worker whose four completed tool rows each put a grapheme cluster across the');
  console.log('60-code-unit truncation cut: a ZWJ family emoji, a Devanagari conjunct, a');
  console.log('regional-indicator flag, and a combining acute. Resets only its own session.');
  console.log('');
  console.log('Example:');
  console.log('  pnpm dev:seed app:mobile-tool-card-truncation ada@example.com');
}

function textPart(id: string, text: string, messageID: string): SessionIngestItem {
  return {
    type: 'part',
    data: { id, sessionID: SESSION_ID, messageID, type: 'text', text },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function waitForParts(baseUrl: string, token: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const response = await fetch(`${baseUrl}/api/session/${SESSION_ID}/messages?limit=50`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`messages read failed (${response.status})`);
    const payload: unknown = await response.json();
    const seen = new Set<string>();
    if (isRecord(payload) && isRecord(payload.history) && Array.isArray(payload.history.messages)) {
      for (const message of payload.history.messages) {
        if (!isRecord(message) || !Array.isArray(message.parts)) continue;
        for (const part of message.parts) {
          if (isRecord(part) && typeof part.id === 'string') seen.add(part.id);
        }
      }
    }
    if (EXPECTED.every(id => seen.has(id))) return;
    if (Date.now() > deadline) throw new Error('timed out waiting for tool card truncation parts');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }
  const email = args[0]?.trim();
  if (!email) {
    printUsage();
    throw new Error('email is required');
  }
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error('NEXTAUTH_SECRET is not set for this worktree.');
  }

  assertLocalSeedDatabase('app:mobile-tool-card-truncation');
  const db = getSeedDb();
  const [user] = await db
    .select({
      id: kilocode_users.id,
      apiTokenPepper: kilocode_users.api_token_pepper,
      isAdmin: kilocode_users.is_admin,
    })
    .from(kilocode_users)
    .where(eq(kilocode_users.google_user_email, email))
    .limit(1);
  if (!user) {
    throw new Error(`No user for ${email}.`);
  }

  const status = parseSessionIngestServiceStatus(
    execFileSync('pnpm', ['-s', 'dev:status', '--json'], { encoding: 'utf8' })
  );
  if (status.status !== 'up') {
    throw new Error(`cloudflare-session-ingest is ${status.status}.`);
  }
  const baseUrl = `http://localhost:${status.port}`;

  await db
    .delete(cli_sessions_v2)
    .where(
      and(eq(cli_sessions_v2.kilo_user_id, user.id), eq(cli_sessions_v2.session_id, SESSION_ID))
    );
  await db.insert(cli_sessions_v2).values({
    session_id: SESSION_ID,
    kilo_user_id: user.id,
    title: SESSION_TITLE,
    created_on_platform: 'cli',
  });

  const { token } = await signKiloToken({
    userId: user.id,
    pepper: user.apiTokenPepper,
    secret,
    ...seedTokenSigningParams(3600),
    extra: user.isAdmin ? { isAdmin: true } : undefined,
  });

  const items: SessionIngestItem[] = [
    buildSessionItem({
      sessionId: SESSION_ID,
      slug: 'tool-card-truncation-fixture',
      title: SESSION_TITLE,
    }),
    buildUserMessageItem({ messageId: PROMPT_ID, sessionId: SESSION_ID, createdAt: T0 }),
    textPart(PROMPT_PART, PROMPT_TEXT, PROMPT_ID),
    buildAssistantMessageItem({
      messageId: FIRST_ASSISTANT_ID,
      sessionId: SESSION_ID,
      parentId: PROMPT_ID,
      createdAt: FIRST_CREATED,
      completedAt: FIRST_DONE,
      cost: 0.01,
      tokens: { total: 90, input: 70, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
    textPart(FIRST_TEXT_PART, FIRST_TEXT, FIRST_ASSISTANT_ID),
    buildToolPartItem({
      partId: FAMILY_PART,
      sessionId: SESSION_ID,
      messageId: FIRST_ASSISTANT_ID,
      callId: 'callTruncationFamily1',
      tool: 'bash',
      status: 'completed',
      input: { command: BASH_FAMILY_COMMAND },
      output: 'wrote /tmp/family.txt (1 file, 412 KB)',
      title: 'bash',
      metadata: { exitCode: 0 },
      start: FIRST_START,
      end: FIRST_END,
    }),
    buildAssistantMessageItem({
      messageId: SECOND_ASSISTANT_ID,
      sessionId: SESSION_ID,
      parentId: PROMPT_ID,
      createdAt: SECOND_CREATED,
      completedAt: SECOND_DONE,
      cost: 0.01,
      tokens: { total: 95, input: 75, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
    textPart(SECOND_TEXT_PART, SECOND_TEXT, SECOND_ASSISTANT_ID),
    buildToolPartItem({
      partId: CONJUNCT_PART,
      sessionId: SESSION_ID,
      messageId: SECOND_ASSISTANT_ID,
      callId: 'callTruncationConjunc',
      tool: 'bash',
      status: 'completed',
      input: { command: BASH_CONJUNCT_COMMAND },
      output: 'tenant cache keys: 12 checked, 0 stale',
      title: 'bash',
      metadata: { exitCode: 0 },
      start: SECOND_START,
      end: SECOND_END,
    }),
    buildAssistantMessageItem({
      messageId: THIRD_ASSISTANT_ID,
      sessionId: SESSION_ID,
      parentId: PROMPT_ID,
      createdAt: THIRD_CREATED,
      completedAt: THIRD_DONE,
      cost: 0.02,
      tokens: { total: 140, input: 90, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
    textPart(THIRD_TEXT_PART, THIRD_TEXT, THIRD_ASSISTANT_ID),
    buildToolPartItem({
      partId: WEBSEARCH_PART,
      sessionId: SESSION_ID,
      messageId: THIRD_ASSISTANT_ID,
      callId: 'callTruncationSearch',
      tool: 'websearch',
      status: 'completed',
      input: { query: WEBSEARCH_QUERY },
      output: 'Three matching release notes pages.',
      title: 'websearch',
      metadata: { results: 3 },
      start: THIRD_START,
      end: THIRD_END,
    }),
    buildAssistantMessageItem({
      messageId: FOURTH_ASSISTANT_ID,
      sessionId: SESSION_ID,
      parentId: PROMPT_ID,
      createdAt: FOURTH_CREATED,
      completedAt: FOURTH_DONE,
      cost: 0.02,
      tokens: { total: 150, input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
    textPart(FOURTH_TEXT_PART, FOURTH_TEXT, FOURTH_ASSISTANT_ID),
    buildToolPartItem({
      partId: TASK_PART,
      sessionId: SESSION_ID,
      messageId: FOURTH_ASSISTANT_ID,
      callId: 'callTruncationTask01',
      tool: 'task',
      status: 'completed',
      input: { prompt: TASK_PROMPT },
      output: 'Checklist summarised in four bullets.',
      title: 'task',
      metadata: {},
      start: FOURTH_START,
      end: FOURTH_END,
    }),
  ];

  const ingestResponse = await fetch(`${baseUrl}/api/session/${SESSION_ID}/ingest?v=1`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: items }),
  });
  if (!ingestResponse.ok) {
    throw new Error(`ingest failed (${ingestResponse.status}): ${await ingestResponse.text()}`);
  }
  await waitForParts(baseUrl, token);

  console.log(
    'This fixture represents: one read-only session whose four completed tool rows put a ZWJ family emoji, a Devanagari conjunct, a regional-indicator flag, and a combining acute across the 60-code-unit label cut.'
  );
  console.log(
    'Note: a build that cuts at code units renders a lone surrogate, a partial conjunct, a single regional indicator, and an unaccented letter; a build that cuts at grapheme boundaries keeps each cluster whole.'
  );
  console.log(
    'Suggested next step: open the deep link on a signed-in dev build and read the four tool rows.'
  );
  return {
    userId: user.id,
    sessionId: SESSION_ID,
    sessionTitle: SESSION_TITLE,
    deepLink: `kiloapp:///(app)/agent-chat/${SESSION_ID}`,
  };
}
