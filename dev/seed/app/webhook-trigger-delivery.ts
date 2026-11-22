import { execFileSync } from 'node:child_process';

import { cli_sessions_v2, kilocode_users } from '@kilocode/db/schema';
import { signKiloToken } from '@kilocode/worker-utils';
import { and, eq, or } from 'drizzle-orm';
import { z } from 'zod';

import type { SeedResult } from '../index';
import { assertLocalSeedDatabase, getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import {
  buildAssistantMessageItem,
  buildSessionItem,
  buildUserMessageItem,
  parseSessionIngestServiceStatus,
  type SessionIngestItem,
} from '../lib/mobile-sheet-fixtures';
import { seedTokenSigningParams } from '../lib/token-signing';
import { isValidEmail } from '../lib/users';

export const usage = '<email> [--trigger-id=<id>] [--messages] [--empty]';

/**
 * The model the local stack's catalog validates. `POST /api/openrouter/models/validate`
 * answers `{"valid":true}` for it; the seeded catalog lists nothing else.
 */
const FIXTURE_MODEL = 'openai/gpt-5';
const FIXTURE_MODE = 'code';
const FIXTURE_GIT_URL = 'https://gitlab.com/fixture/webhook-delivery.git';
const FIXTURE_PROMPT =
  'Triage the failed deploy of payments-api and report the first failing step.';
const DEFAULT_TRIGGER_ID = 'seed-webhook-delivery';
const TRIGGER_PROMPT_TEMPLATE = 'Investigate this webhook delivery.\n\n{{body}}';

/** The two messages `--messages` ingests into the prepared session. */
const MESSAGE_USER_TEXT = 'Triage the failed deploy of payments-api.';
const MESSAGE_ASSISTANT_TEXT =
  'The deploy failed at the build step; the failing job is `test`.';
const DELIVERY_MESSAGE_COUNT = 2;
const MESSAGE_BASE_CREATED_AT = 1_700_400_000_000;

/**
 * The `--empty` session. `prepareSession` cannot record a session without an
 * admitted turn (its non-clone input requires a non-empty `prompt`), so the
 * empty case is the historical shape `app:condensed-history` seeds: an owned
 * `cli_sessions_v2` row with no cloud-agent runtime and no transcript.
 */
const EMPTY_SESSION_ID = 'ses_000000000012WebhookEmpty01';
const EMPTY_SESSION_TITLE = 'Webhook delivery empty session';

const BACKEND_URL = 'http://127.0.0.1:3000';
// Control-token routes (cloudAgentNext.prepareSession) accept only the legacy
// five-year API-token lifetime; see dev/seed/app/api-token.ts.
const TOKEN_EXPIRES_SECONDS = 1825 * 24 * 60 * 60;
// The control plane hydrates a prepared session's transcript from
// session-ingest on the first page read, so the read is repeated for a moment
// instead of failing on the first answer.
const HYDRATION_POLL_TIMEOUT_MS = 15_000;
const HYDRATION_POLL_INTERVAL_MS = 500;

type SeedMode = 'default' | 'messages' | 'empty';

const PrepareSessionOutputSchema = z.object({
  cloudAgentSessionId: z.string().min(1),
  kiloSessionId: z.string().min(1),
});

const TriggerCreateOutputSchema = z.object({
  triggerId: z.string().min(1),
  inboundUrl: z.string().min(1),
});

const CaptureOutputSchema = z.object({
  success: z.boolean(),
  data: z.object({ requestId: z.string().min(1) }).optional(),
  error: z.string().optional(),
});

const RuntimeStateSchema = z
  .object({ initialMessageId: z.string().nullable().optional() })
  .nullable();

const RuntimeSessionSchema = z.object({ runtimeState: RuntimeStateSchema }).loose();

const MessagesPageSchema = z
  .object({
    kind: z.string().optional(),
    messages: z.array(z.unknown()),
    nextCursor: z.string().nullable(),
  })
  .loose();

const DeliveryRowSchema = z
  .object({
    id: z.string(),
    processStatus: z.string(),
    cloudAgentSessionId: z.string().nullable(),
    kiloSessionId: z.string().nullable(),
  })
  .loose();

const DeliveriesSchema = z.array(DeliveryRowSchema);

const SessionHistorySchema = z
  .object({
    kind: z.string().optional(),
    messages: z.array(z.unknown()),
    nextCursor: z.string().nullable(),
  })
  .loose();

const SessionIngestMessagesResponseSchema = z
  .object({
    success: z.literal(true),
    history: SessionHistorySchema.nullable(),
  })
  .loose();

/**
 * The app's transcript page for a stored Kilo session
 * (`cliSessionsV2.getSessionMessagesPage`). Its `history` is the stored page or
 * a typed failure; `null` means the session has no stored transcript yet.
 */
const StoredHistorySchema = z.union([
  z
    .object({ messages: z.array(z.unknown()), nextCursor: z.string().nullable() })
    .loose(),
  z.object({ kind: z.string() }).loose(),
]);

const StoredPageSchema = z
  .object({
    kiloSessionId: z.string().min(1),
    history: StoredHistorySchema.nullable(),
  })
  .loose();

function readStoredPageCount(page: unknown): number {
  const parsed = StoredPageSchema.parse(page);
  if (parsed.history === null) return 0;
  if ('kind' in parsed.history) {
    throw new Error(`session-ingest reported ${parsed.history.kind} for ${parsed.kiloSessionId}`);
  }
  return parsed.history.messages.length;
}

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:webhook-trigger-delivery ${usage}`);
  console.log('');
  console.log('Prepares one Cloud Agent session through the real prepareSession procedure');
  console.log('(gitUrl repository, no GitHub integration, an initial prompt) and one personal');
  console.log('webhook trigger owned by the same account.');
  console.log('It does NOT initiate the prepared session, so the session keeps its metadata');
  console.log('(non-null initialMessageId) and an empty transcript.');
  console.log('');
  console.log('--messages  also ingests two messages (one user, one assistant) into that');
  console.log('            session through session-ingest, then re-reads the app page so the');
  console.log('            control plane hydrates them; reports hydratedMessageCount.');
  console.log('--empty     seeds the no-admitted-turn case instead: an owned cli_sessions_v2');
  console.log('            row without a cloud-agent runtime and without a transcript, so');
  console.log('            initialMessageId is null and the messages page is empty.');
  console.log('');
  console.log('Examples:');
  console.log('  pnpm -s dev:seed app:webhook-trigger-delivery e2e-fake@example.com --json');
  console.log('  pnpm -s dev:seed app:webhook-trigger-delivery e2e-fake@example.com --messages');
  console.log('  pnpm -s dev:seed app:webhook-trigger-delivery e2e-fake@example.com --empty');
}

function parseArgs(args: string[]): { email: string; triggerId: string; mode: SeedMode } {
  const positionals: string[] = [];
  let triggerId = DEFAULT_TRIGGER_ID;
  let messages = false;
  let empty = false;
  for (const arg of args) {
    if (arg.startsWith('--trigger-id=')) {
      triggerId = arg.slice('--trigger-id='.length).trim();
      continue;
    }
    if (arg === '--messages') {
      messages = true;
      continue;
    }
    if (arg === '--empty') {
      empty = true;
      continue;
    }
    if (arg.startsWith('--')) throw new Error(`Unknown argument: ${arg}`);
    positionals.push(arg.trim());
  }
  if (messages && empty) throw new Error('Choose either --messages or --empty, not both');
  const [email, ...rest] = positionals;
  if (!email) {
    printUsage();
    throw new Error('email is required');
  }
  if (rest.length > 0) throw new Error(`Unexpected extra arguments: ${rest.join(' ')}`);
  if (!isValidEmail(email)) throw new Error(`email is not a valid address: ${email}`);
  const mode: SeedMode = messages ? 'messages' : empty ? 'empty' : 'default';
  return { email, triggerId, mode };
}

/** One tRPC procedure call over the web app's HTTP endpoint; answers `result.data`. */
async function trpc(path: string, token: string, input: unknown): Promise<unknown> {
  const response = await fetch(`${BACKEND_URL}/api/trpc/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
  });
  const body: unknown = await response.json().catch(() => null);
  const envelope = z
    .union([z.array(z.unknown()), z.unknown()])
    .parse(body);
  const single = Array.isArray(envelope) ? envelope[0] : envelope;
  if (!response.ok) {
    throw new Error(`${path} failed (${response.status}): ${JSON.stringify(single ?? body)}`);
  }
  const result = z.object({ result: z.object({ data: z.unknown() }) }).parse(single);
  return result.result.data;
}

function readMessageCount(page: unknown): number {
  const parsed = MessagesPageSchema.parse(page);
  return parsed.messages.length;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readSessionIngestStatusJson(): string {
  try {
    return execFileSync('pnpm', ['-s', 'dev:status', '--json'], { encoding: 'utf8' });
  } catch (error) {
    throw new Error(
      `dev:status --json failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function ingestSession(
  baseUrl: string,
  sessionId: string,
  token: string,
  items: SessionIngestItem[]
): Promise<void> {
  const response = await fetch(`${baseUrl}/api/session/${sessionId}/ingest?v=1`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ data: items }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ingest of ${sessionId} failed (${response.status}): ${body}`);
  }
}

/** A text part item, the shape session-ingest replays into the transcript. */
function buildTextPartItem(params: {
  partId: string;
  sessionId: string;
  messageId: string;
  text: string;
}): SessionIngestItem {
  return {
    type: 'part',
    data: {
      id: params.partId,
      sessionID: params.sessionId,
      messageID: params.messageId,
      type: 'text',
      text: params.text,
    },
  };
}

/**
 * Ids come from the session id, so a re-run against the same session cannot
 * collide with the previous run's rows, and a different session never shares them.
 */
function buildDeliveryMessageIngestItems(sessionId: string): SessionIngestItem[] {
  const tag = sessionId.slice('ses_'.length, 'ses_'.length + 12).toLowerCase();
  const userMessageId = `msgHook${tag}User`;
  const assistantMessageId = `msgHook${tag}Asst`;
  return [
    buildSessionItem({
      sessionId,
      slug: 'webhook-trigger-delivery',
      title: 'Webhook delivery messages',
    }),
    buildUserMessageItem({
      messageId: userMessageId,
      sessionId,
      createdAt: MESSAGE_BASE_CREATED_AT,
    }),
    buildTextPartItem({
      partId: `prtHook${tag}UserText`,
      sessionId,
      messageId: userMessageId,
      text: MESSAGE_USER_TEXT,
    }),
    buildAssistantMessageItem({
      messageId: assistantMessageId,
      sessionId,
      parentId: userMessageId,
      createdAt: MESSAGE_BASE_CREATED_AT + 5_000,
      completedAt: MESSAGE_BASE_CREATED_AT + 7_000,
      cost: 0.001,
      tokens: {
        total: 40,
        input: 20,
        output: 16,
        reasoning: 0,
        cache: { read: 2, write: 2 },
      },
    }),
    buildTextPartItem({
      partId: `prtHook${tag}AsstText`,
      sessionId,
      messageId: assistantMessageId,
      text: MESSAGE_ASSISTANT_TEXT,
    }),
  ];
}

/**
 * Reads the app's own transcript page for the prepared cloud-agent session.
 * The control plane serves this page from its Durable Object, and a prepared
 * session's registration marks its history hydrated before any row exists, so
 * a page that stays empty is the normal answer for a session nothing ran in.
 */
async function readCloudAgentPageCount(
  token: string,
  cloudAgentSessionId: string
): Promise<{ count: number; page: unknown }> {
  const page = await trpc('cloudAgentNext.getSessionMessagesPage', token, {
    sessionId: cloudAgentSessionId,
  });
  return { count: readMessageCount(page), page };
}

/** The same transcript read by stored Kilo session id: `cliSessionsV2`. */
async function pollStoredPage(
  token: string,
  kiloSessionId: string,
  expected: number
): Promise<{ count: number; page: unknown }> {
  const deadline = Date.now() + HYDRATION_POLL_TIMEOUT_MS;
  for (;;) {
    const page = await trpc('cliSessionsV2.getSessionMessagesPage', token, {
      session_id: kiloSessionId,
    });
    const count = readStoredPageCount(page);
    if (count >= expected || Date.now() >= deadline) return { count, page };
    await sleep(HYDRATION_POLL_INTERVAL_MS);
  }
}

/** The stored transcript count straight from session-ingest; no history is 0. */
async function readIngestedMessageCount(
  baseUrl: string,
  sessionId: string,
  token: string
): Promise<number> {
  const response = await fetch(`${baseUrl}/api/session/${sessionId}/messages?limit=100`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(`Messages read of ${sessionId} failed (${response.status})`);
  }
  const payload: unknown = await response.json();
  const parsed = SessionIngestMessagesResponseSchema.parse(payload);
  const history = parsed.history;
  if (history === null) return 0;
  if (history.kind !== undefined) {
    throw new Error(`session-ingest reported ${history.kind} for ${sessionId}`);
  }
  return history.messages.length;
}

/**
 * Ingest can stage through the queue, so the stored transcript is confirmed
 * before the app page is read: a hydration that runs against an empty store
 * finishes complete and never re-reads it.
 */
async function pollIngestedMessages(
  baseUrl: string,
  sessionId: string,
  token: string,
  expected: number
): Promise<number> {
  const deadline = Date.now() + HYDRATION_POLL_TIMEOUT_MS;
  for (;;) {
    const count = await readIngestedMessageCount(baseUrl, sessionId, token);
    if (count >= expected || Date.now() >= deadline) {
      if (count < expected) {
        throw new Error(
          `Timed out waiting for ${expected} ingested messages in ${sessionId}; saw ${count}`
        );
      }
      return count;
    }
    await sleep(HYDRATION_POLL_INTERVAL_MS);
  }
}

async function main(args: string[]): Promise<SeedResult> {
  const { email, triggerId, mode } = parseArgs(args);

  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error(
      'NEXTAUTH_SECRET is not set for this worktree. Ensure local env is prepared (pnpm dev:worktree:prepare).'
    );
  }

  assertLocalSeedDatabase('app:webhook-trigger-delivery');
  const db = getSeedDb();
  const normalizedEmail = normalizeSeedEmail(email);
  const matches = await db
    .select({
      userId: kilocode_users.id,
      email: kilocode_users.google_user_email,
      apiTokenPepper: kilocode_users.api_token_pepper,
    })
    .from(kilocode_users)
    .where(
      or(
        eq(kilocode_users.google_user_email, email),
        eq(kilocode_users.normalized_email, normalizedEmail)
      )
    );
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one user for ${email}, found ${matches.length}. Sign in locally first.`
    );
  }
  const [user] = matches;

  const { token } = await signKiloToken({
    userId: user.userId,
    pepper: user.apiTokenPepper,
    secret,
    ...seedTokenSigningParams(TOKEN_EXPIRES_SECONDS),
  });

  const serviceStatus = parseSessionIngestServiceStatus(readSessionIngestStatusJson());
  if (serviceStatus.status !== 'up') {
    throw new Error(
      `cloudflare-session-ingest is not up (status=${serviceStatus.status}). Start the local stack first.`
    );
  }
  const sessionIngestUrl = `http://localhost:${serviceStatus.port}`;

  let prepared: { cloudAgentSessionId: string | null; kiloSessionId: string };
  let emptySessionId: string | null = null;
  if (mode === 'empty') {
    // `prepareSession`'s non-clone input requires a non-empty prompt, so a
    // prepared session always records an admitted turn. The no-turn case is the
    // historical row shape instead: owned, no runtime, no transcript. A re-run
    // deletes this seed's own row first.
    await db
      .delete(cli_sessions_v2)
      .where(
        and(
          eq(cli_sessions_v2.kilo_user_id, user.userId),
          eq(cli_sessions_v2.session_id, EMPTY_SESSION_ID)
        )
      );
    await db.insert(cli_sessions_v2).values({
      session_id: EMPTY_SESSION_ID,
      kilo_user_id: user.userId,
      title: EMPTY_SESSION_TITLE,
      created_on_platform: 'cloud-agent-web',
      cloud_agent_session_id: null,
    } satisfies typeof cli_sessions_v2.$inferInsert);
    emptySessionId = EMPTY_SESSION_ID;
    prepared = { cloudAgentSessionId: null, kiloSessionId: EMPTY_SESSION_ID };
  } else {
    // 1. Prepare a real control-plane session: `gitUrl` needs no GitHub integration,
    //    and the initial prompt is recorded in the session metadata as
    //    `initialMessage.id` even though the run is never initiated.
    prepared = PrepareSessionOutputSchema.parse(
      await trpc('cloudAgentNext.prepareSession', token, {
        publicRepoUrl: FIXTURE_GIT_URL,
        mode: FIXTURE_MODE,
        model: FIXTURE_MODEL,
        prompt: FIXTURE_PROMPT,
        createdOnPlatform: 'cloud-agent-web',
        clientProvenance: 'browser',
        githubAccessPurpose: 'agent',
      })
    );
  }

  // 2. The trigger the delivery row hangs off. A plain githubRepo is not verified
  //    by the create path (it only checks ownership and the worker's config).
  const triggerInput = {
    triggerId,
    targetType: 'cloud_agent' as const,
    githubRepo: 'devseed-acme/mobile-sheet-fixtures',
    mode: FIXTURE_MODE,
    model: FIXTURE_MODEL,
    promptTemplate: TRIGGER_PROMPT_TEMPLATE,
  };
  let created = true;
  let trigger: z.infer<typeof TriggerCreateOutputSchema>;
  try {
    trigger = TriggerCreateOutputSchema.parse(
      await trpc('webhookTriggers.create', token, triggerInput)
    );
  } catch {
    // A re-run finds the trigger already created; read the same shape back.
    created = false;
    trigger = TriggerCreateOutputSchema.parse(
      await trpc('webhookTriggers.get', token, { triggerId })
    );
  }

  // 3. Capture one request through the real public inbound route, so the Trigger
  //    DO holds a delivery row for this trigger.
  const captureResponse = await fetch(trigger.inboundUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'deploy.failed', service: 'payments-api' }),
  });
  const captured = CaptureOutputSchema.parse(await captureResponse.json());

  // 4. `--messages` writes a real transcript into the prepared session's own
  //    session-ingest id (a session item first, then the two messages), so the
  //    stored page every reader falls back to carries it.
  let hydratedMessageCount: number;
  let page: unknown = null;
  let storedPageCount: number;
  if (mode === 'messages') {
    if (prepared.cloudAgentSessionId === null) throw new Error('prepared session is missing');
    await ingestSession(
      sessionIngestUrl,
      prepared.kiloSessionId,
      token,
      buildDeliveryMessageIngestItems(prepared.kiloSessionId)
    );
    await pollIngestedMessages(
      sessionIngestUrl,
      prepared.kiloSessionId,
      token,
      DELIVERY_MESSAGE_COUNT
    );
    const settled = await pollStoredPage(token, prepared.kiloSessionId, DELIVERY_MESSAGE_COUNT);
    hydratedMessageCount = settled.count;
    storedPageCount = settled.count;
    page = settled.page;
  } else if (mode === 'empty') {
    // Nothing was ingested: the stored transcript must stay at zero messages.
    hydratedMessageCount = await pollIngestedMessages(
      sessionIngestUrl,
      prepared.kiloSessionId,
      token,
      0
    );
    page = await trpc('cliSessionsV2.getSessionMessagesPage', token, {
      session_id: prepared.kiloSessionId,
    });
    storedPageCount = readStoredPageCount(page);
  } else {
    page = await trpc('cloudAgentNext.getSessionMessagesPage', token, {
      sessionId: prepared.cloudAgentSessionId,
    });
    hydratedMessageCount = readMessageCount(page);
    storedPageCount = hydratedMessageCount;
  }

  // 5. The reads the app makes.
  const runtime = RuntimeSessionSchema.parse(
    await trpc('cliSessionsV2.getWithRuntimeState', token, { session_id: prepared.kiloSessionId })
  );
  // The prepared session's own page is served by its Durable Object, whose
  // registration marks history hydrated before any row exists; report it so
  // the ingestion is not mistaken for a hydration the control plane performed.
  const cloudPage =
    prepared.cloudAgentSessionId === null
      ? null
      : await readCloudAgentPageCount(token, prepared.cloudAgentSessionId);
  const deliveries = DeliveriesSchema.parse(
    await trpc('webhookTriggers.listRequests', token, { triggerId })
  );

  return {
    mode,
    userId: user.userId,
    email: user.email,
    triggerId: trigger.triggerId,
    triggerCreated: created,
    inboundUrl: trigger.inboundUrl,
    captureStatus: captureResponse.status,
    requestId: captured.data?.requestId ?? null,
    cloudAgentSessionId: prepared.cloudAgentSessionId,
    kiloSessionId: prepared.kiloSessionId,
    emptySessionId,
    initialMessageId: runtime.runtimeState?.initialMessageId ?? null,
    messageCount: storedPageCount,
    hydratedMessageCount,
    cloudAgentPageMessageCount: cloudPage === null ? null : cloudPage.count,
    cloudAgentPage: cloudPage === null ? null : JSON.stringify(cloudPage.page),
    messagesPage: JSON.stringify(page),
    sessionIngestPort: serviceStatus.port,
    deliveredRows: JSON.stringify(deliveries),
  };
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }
  return await main(args);
}
