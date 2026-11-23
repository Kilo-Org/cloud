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

export const usage =
  '<email> [--trigger-id=<id>] [--messages] [--empty] [--admitted] [--stack-dir=<path>]';

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
const MESSAGE_ASSISTANT_TEXT = 'The deploy failed at the build step; the failing job is `test`.';
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

/**
 * The `--admitted` trigger, separate from the default one so its delivery row
 * belongs to its own trigger and a re-run never rewrites the other mode's rows.
 */
const DEFAULT_ADMITTED_TRIGGER_ID = 'seed-webhook-delivery-admitted';
/**
 * How long `--admitted` watches the run it started. The question that mode
 * answers is what the local stack does with an admitted turn, and both answers
 * (the turn settles failed, or it stays queued) are only visible after the
 * workspace's preparation attempt has reported back.
 */
const ADMISSION_SETTLE_TIMEOUT_MS = 120_000;
const ADMISSION_SETTLE_POLL_INTERVAL_MS = 2_000;

// Control-token routes (cloudAgentNext.prepareSession) accept only the legacy
// five-year API-token lifetime; see dev/seed/app/api-token.ts.
const TOKEN_EXPIRES_SECONDS = 1825 * 24 * 60 * 60;
// The control plane hydrates a prepared session's transcript from
// session-ingest on the first page read, so the read is repeated for a moment
// instead of failing on the first answer.
const HYDRATION_POLL_TIMEOUT_MS = 15_000;
const HYDRATION_POLL_INTERVAL_MS = 500;

type SeedMode = 'default' | 'messages' | 'empty' | 'admitted';

/** The parsed command line: one account, one personal trigger, one seeding mode. */
type SeedInvocation = {
  readonly email: string;
  readonly triggerId: string;
  readonly mode: SeedMode;
  /**
   * The worktree whose running stack answers the calls. `undefined` means the
   * checkout this seed runs from, which is right for a single-worktree stack
   * and wrong when a sibling worktree holds the live stack.
   */
  readonly stackDir: string | undefined;
};

/**
 * The two ports this fixture needs, read from the stack's own manifest through
 * `dev:status`. The backend is not always on 3000: a worktree stack runs at
 * `3000 + KILO_PORT_OFFSET`, and a seed that assumed 3000 would silently talk
 * to another worktree's app (or to nothing).
 */
type StackPorts = {
  readonly backendUrl: string;
  readonly sessionIngestUrl: string;
  readonly sessionIngestPort: number;
};

/** A control-plane session `main` seeds against: the runtime id and the stored id. */
type PreparedSession = {
  readonly cloudAgentSessionId: string | null;
  readonly kiloSessionId: string;
};

/**
 * `result.data` of a tRPC call. Every procedure this seed reads answers a JSON
 * document, so one module-level schema names what `trpc` hands back.
 */
const TrpcDataSchema = z.json();
type TrpcData = z.infer<typeof TrpcDataSchema>;

const TrpcEnvelopeSchema = z.union([z.array(z.unknown()), z.unknown()]);
const TrpcResultSchema = z.object({ result: z.object({ data: TrpcDataSchema }) });

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
  .object({
    initialMessageId: z.string().nullable().optional(),
    // The Durable Object's own lifecycle: `preparedAt` is registration,
    // `initiatedAt` is the admission of the initial turn.
    preparedAt: z.number().nullable().optional(),
    initiatedAt: z.number().nullable().optional(),
  })
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
  z.object({ messages: z.array(z.unknown()), nextCursor: z.string().nullable() }).loose(),
  z.object({ kind: z.string() }).loose(),
]);

const StoredPageSchema = z
  .object({
    kiloSessionId: z.string().min(1),
    history: StoredHistorySchema.nullable(),
  })
  .loose();

function readStoredPageCount(page: TrpcData): number {
  const parsed = StoredPageSchema.parse(page);
  if (parsed.history === null) return 0;
  if ('kind' in parsed.history) {
    throw new Error(
      `session-ingest reported ${String(parsed.history.kind)} for ${parsed.kiloSessionId}`
    );
  }
  return parsed.history.messages.length;
}

/** `cloudAgentNext.initiateFromPreparedSession`'s answer (the legacy execution ack). */
const InitiateOutputSchema = z
  .object({
    messageId: z.string().min(1),
    delivery: z.enum(['sent', 'queued']).optional(),
    status: z.string().optional(),
  })
  .loose();

/**
 * The first page's snapshot rows: the stream's own replay of an admitted turn.
 * A turn the Durable Object has not sent stays in `queuedMessages` with
 * `delivery: 'queued'`; one that failed carries `terminalFailure`. The
 * preparation list is where a workspace that never came up reports itself.
 */
const PageSnapshotRowsSchema = z
  .object({
    preparationAttempts: z
      .array(
        z
          .object({
            id: z.string(),
            status: z.string(),
            safeError: z.string().optional(),
          })
          .loose()
      )
      .optional(),
    queuedMessages: z
      .array(
        z
          .object({
            messageId: z.string(),
            delivery: z.enum(['queued', 'sent']).optional(),
            completedAt: z.number().optional(),
            terminalFailure: z.object({ timestamp: z.number() }).loose().optional(),
          })
          .loose()
      )
      .optional(),
  })
  .loose();

/** What the first page says about the admitted turn, in the page's own terms. */
type AdmissionSnapshot = {
  readonly queuedMessageCount: number;
  readonly queuedDelivery: string;
  readonly terminalFailureCount: number;
  readonly preparationAttemptCount: number;
  readonly failedPreparationCount: number;
  readonly preparationStatus: string;
  readonly preparationError: string;
};

function readAdmissionSnapshot(page: TrpcData): AdmissionSnapshot {
  const parsed = PageSnapshotRowsSchema.parse(page);
  const queued = parsed.queuedMessages ?? [];
  const preparations = parsed.preparationAttempts ?? [];
  const failed = preparations.filter(attempt => attempt.status === 'failed');
  const newest = preparations.at(-1);
  return {
    queuedMessageCount: queued.length,
    queuedDelivery: queued.map(message => message.delivery ?? 'queued').join(','),
    terminalFailureCount: queued.filter(message => message.terminalFailure !== undefined).length,
    preparationAttemptCount: preparations.length,
    failedPreparationCount: failed.length,
    preparationStatus: newest?.status ?? 'none',
    preparationError: failed.at(-1)?.safeError ?? '',
  };
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
  console.log('--admitted  prepares the same real session, then calls the real');
  console.log('            initiateFromKilocodeSessionV2 so the Durable Object admits the');
  console.log('            initial turn, and ingests nothing. Asserts session-ingest holds 0');
  console.log('            messages, the page holds 0 rows, and the admitted turn is the');
  console.log("            session's own initial turn with a row on the first page; reports");
  console.log('            admittedMessages, the turn state and the preparation attempts, so');
  console.log("            the stack's answer for a turn that never produces rows is visible.");
  console.log('--stack-dir=<path>');
  console.log('            the worktree whose running stack answers the calls (default: this');
  console.log('            checkout). A sibling worktree stack is on its own KILO_PORT_OFFSET.');
  console.log('');
  console.log('Examples:');
  console.log('  pnpm -s dev:seed app:webhook-trigger-delivery e2e-fake@example.com --json');
  console.log('  pnpm -s dev:seed app:webhook-trigger-delivery e2e-fake@example.com --messages');
  console.log('  pnpm -s dev:seed app:webhook-trigger-delivery e2e-fake@example.com --empty');
  console.log('  pnpm -s dev:seed app:webhook-trigger-delivery e2e-fake@example.com --admitted');
}

function parseArgs(args: string[]): SeedInvocation {
  const positionals: string[] = [];
  let triggerId: string | undefined;
  let stackDir: string | undefined;
  let messages = false;
  let empty = false;
  let admitted = false;
  for (const arg of args) {
    if (arg.startsWith('--trigger-id=')) {
      triggerId = arg.slice('--trigger-id='.length).trim();
      continue;
    }
    if (arg.startsWith('--stack-dir=')) {
      stackDir = arg.slice('--stack-dir='.length).trim();
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
    if (arg === '--admitted') {
      admitted = true;
      continue;
    }
    if (arg.startsWith('--')) throw new Error(`Unknown argument: ${arg}`);
    positionals.push(arg.trim());
  }
  const modes = [messages, empty, admitted].filter(Boolean).length;
  if (modes > 1) throw new Error('Choose one of --messages, --empty or --admitted');
  if (stackDir === '') throw new Error('--stack-dir= needs a path');
  const [email, ...rest] = positionals;
  if (!email) {
    printUsage();
    throw new Error('email is required');
  }
  if (rest.length > 0) throw new Error(`Unexpected extra arguments: ${rest.join(' ')}`);
  if (!isValidEmail(email)) throw new Error(`email is not a valid address: ${email}`);
  const mode: SeedMode = messages
    ? 'messages'
    : empty
      ? 'empty'
      : admitted
        ? 'admitted'
        : 'default';
  return {
    email,
    // The admitted mode owns a trigger of its own: its delivery row must not
    // rewrite the default mode's row, and both modes stay idempotent.
    triggerId:
      triggerId ?? (mode === 'admitted' ? DEFAULT_ADMITTED_TRIGGER_ID : DEFAULT_TRIGGER_ID),
    mode,
    stackDir,
  };
}

/** One tRPC procedure call over the web app's HTTP endpoint; answers `result.data`. */
async function trpc(
  backendUrl: string,
  path: string,
  token: string,
  input: unknown
): Promise<TrpcData> {
  const response = await fetch(`${backendUrl}/api/trpc/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
  });
  const body: TrpcData = await response.json().catch(() => null);
  const envelope = TrpcEnvelopeSchema.parse(body);
  const single = Array.isArray(envelope) ? envelope[0] : envelope;
  if (!response.ok) {
    throw new Error(`${path} failed (${response.status}): ${JSON.stringify(single ?? body)}`);
  }
  return TrpcResultSchema.parse(single).result.data;
}

function readMessageCount(page: TrpcData): number {
  const parsed = MessagesPageSchema.parse(page);
  return parsed.messages.length;
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/**
 * `dev:status --json` from the stack's own worktree. The runner is invoked
 * there because a worktree stack's ports come from that worktree's manifest:
 * asked from here, a sibling's stack is invisible and its ports unknown.
 */
function readStackStatusJson(stackDir: string | undefined): string {
  try {
    return execFileSync('pnpm', ['-s', 'dev:status', '--json'], {
      encoding: 'utf8',
      ...(stackDir === undefined ? {} : { cwd: stackDir }),
    });
  } catch (error) {
    throw new Error(
      `dev:status --json failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** `dev:status --json`: the session plus one entry per service the stack runs. */
const StackStatusSchema = z.object({
  session: z.string(),
  portOffset: z.number(),
  services: z.array(
    z
      .object({
        name: z.string(),
        port: z.number().int(),
        status: z.enum(['up', 'down']),
      })
      .loose()
  ),
});

/**
 * The backend origin and the session-ingest origin of the stack that answers
 * this run. `nextjs` is read from the same status document as session-ingest:
 * a worktree stack serves it at `3000 + KILO_PORT_OFFSET`, so a hard-coded
 * 3000 would reach another worktree's app or nothing at all.
 */
function readStackPorts(json: string): StackPorts {
  const serviceStatus = parseSessionIngestServiceStatus(json);
  if (serviceStatus.status !== 'up') {
    throw new Error(
      `cloudflare-session-ingest is not up (status=${serviceStatus.status}). Start the local stack first.`
    );
  }
  const status = StackStatusSchema.parse(JSON.parse(json));
  const nextjs = status.services.find(service => service.name === 'nextjs');
  if (nextjs === undefined) throw new Error('dev:status --json did not report the nextjs service');
  if (nextjs.status !== 'up') {
    throw new Error(`nextjs is not up (status=${nextjs.status}). Start the local stack first.`);
  }
  return {
    backendUrl: `http://127.0.0.1:${nextjs.port}`,
    sessionIngestUrl: `http://localhost:${serviceStatus.port}`,
    sessionIngestPort: serviceStatus.port,
  };
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
  backendUrl: string,
  token: string,
  cloudAgentSessionId: string
): Promise<{ count: number; page: TrpcData }> {
  const page = await trpc(backendUrl, 'cloudAgentNext.getSessionMessagesPage', token, {
    sessionId: cloudAgentSessionId,
  });
  return { count: readMessageCount(page), page };
}

/** The same transcript read by stored Kilo session id: `cliSessionsV2`. */
async function pollStoredPage(
  backendUrl: string,
  token: string,
  kiloSessionId: string,
  expected: number
): Promise<{ count: number; page: TrpcData }> {
  const deadline = Date.now() + HYDRATION_POLL_TIMEOUT_MS;
  for (;;) {
    const page = await trpc(backendUrl, 'cliSessionsV2.getSessionMessagesPage', token, {
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

/**
 * The page's own count of admitted turns, when the page carries the field. A
 * sibling slice adds `admittedMessages`; against a stack built without it the
 * read is `null`, and the snapshot rows below are the DO's own answer instead.
 */
function readPageAdmittedMessages(page: TrpcData): number | null {
  if (typeof page !== 'object' || page === null || Array.isArray(page)) return null;
  const value = 'admittedMessages' in page ? page.admittedMessages : null;
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/** One settled read of the admitted turn: its page, its snapshot rows, and whether they settled. */
type AdmittedTurnOutcome = {
  readonly page: TrpcData;
  readonly admittedMessages: number | null;
  readonly snapshot: AdmissionSnapshot;
  readonly settled: boolean;
};

/**
 * Watches the admitted turn until the Durable Object's snapshot rows say
 * something terminal about it, or the window closes. Both outcomes are real
 * answers: a failed preparation attempt (the sandbox never came up) and a turn
 * that never leaves `queued` (nothing ran it) look identical in the stored
 * transcript, and only the snapshot rows tell them apart.
 */
async function waitForAdmittedTurnOutcome(
  backendUrl: string,
  token: string,
  cloudAgentSessionId: string
): Promise<AdmittedTurnOutcome> {
  const deadline = Date.now() + ADMISSION_SETTLE_TIMEOUT_MS;
  for (;;) {
    const page = await trpc(backendUrl, 'cloudAgentNext.getSessionMessagesPage', token, {
      sessionId: cloudAgentSessionId,
    });
    const snapshot = readAdmissionSnapshot(page);
    const settled = snapshot.failedPreparationCount > 0 || snapshot.terminalFailureCount > 0;
    if (settled || Date.now() >= deadline) {
      return { page, admittedMessages: readPageAdmittedMessages(page), snapshot, settled };
    }
    await sleep(ADMISSION_SETTLE_POLL_INTERVAL_MS);
  }
}

/**
 * Admits the prepared initial turn. The app's own procedure
 * (`cloudAgentNext.initiateFromPreparedSession`) is what the new-session flow
 * calls, and it forwards this input unchanged to the trigger worker's
 * `initiateFromKilocodeSessionV2`.
 *
 * The worker refuses a payer below its $1 minimum, and a seeded account starts
 * at $0, so that refusal is reported with the seed command that fixes it rather
 * than as a bare 402: the mode cannot reach the state it measures otherwise.
 */
async function initiatePreparedSession(
  backendUrl: string,
  token: string,
  cloudAgentSessionId: string
): Promise<z.infer<typeof InitiateOutputSchema>> {
  try {
    return InitiateOutputSchema.parse(
      await trpc(backendUrl, 'cloudAgentNext.initiateFromPreparedSession', token, {
        cloudAgentSessionId,
      })
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/insufficient credits/i.test(message)) {
      throw new Error(
        `${message}\nThe worker requires a $1 balance for a paid model. Give this account credits first:\n  pnpm -s dev:seed app:add-credits <userId> 25`
      );
    }
    throw error;
  }
}

async function main(args: string[]): Promise<SeedResult> {
  const { email, triggerId, mode, stackDir } = parseArgs(args);

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

  const ports = readStackPorts(readStackStatusJson(stackDir));
  const sessionIngestUrl = ports.sessionIngestUrl;

  let prepared: PreparedSession;
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
      await trpc(ports.backendUrl, 'cloudAgentNext.prepareSession', token, {
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
      await trpc(ports.backendUrl, 'webhookTriggers.create', token, triggerInput)
    );
  } catch {
    // A re-run finds the trigger already created; read the same shape back.
    created = false;
    trigger = TriggerCreateOutputSchema.parse(
      await trpc(ports.backendUrl, 'webhookTriggers.get', token, { triggerId })
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
  //    stored page every reader falls back to carries it. `--admitted` does the
  //    opposite on purpose: it admits the initial turn through the real
  //    procedure and ingests nothing, then reads what the run left behind.
  let hydratedMessageCount: number;
  let page: TrpcData = null;
  let storedPageCount: number;
  /** What session-ingest itself holds; `null` for a mode that never reads it. */
  let ingestedMessageCount: number | null = null;
  let admittedMessages: number | null = null;
  let admittedTurn: AdmittedTurnOutcome | null = null;
  let initiateDelivery: string | null = null;
  let admittedMessageId: string | null = null;
  if (mode === 'messages') {
    if (prepared.cloudAgentSessionId === null) throw new Error('prepared session is missing');
    await ingestSession(
      sessionIngestUrl,
      prepared.kiloSessionId,
      token,
      buildDeliveryMessageIngestItems(prepared.kiloSessionId)
    );
    ingestedMessageCount = await pollIngestedMessages(
      sessionIngestUrl,
      prepared.kiloSessionId,
      token,
      DELIVERY_MESSAGE_COUNT
    );
    const settled = await pollStoredPage(
      ports.backendUrl,
      token,
      prepared.kiloSessionId,
      DELIVERY_MESSAGE_COUNT
    );
    hydratedMessageCount = settled.count;
    storedPageCount = settled.count;
    page = settled.page;
  } else if (mode === 'empty') {
    // Nothing was ingested: the stored transcript must stay at zero messages.
    ingestedMessageCount = await pollIngestedMessages(
      sessionIngestUrl,
      prepared.kiloSessionId,
      token,
      0
    );
    hydratedMessageCount = ingestedMessageCount;
    page = await trpc(ports.backendUrl, 'cliSessionsV2.getSessionMessagesPage', token, {
      session_id: prepared.kiloSessionId,
    });
    storedPageCount = readStoredPageCount(page);
  } else if (mode === 'admitted') {
    if (prepared.cloudAgentSessionId === null) throw new Error('prepared session is missing');
    // 4a. The real admission: the same procedure and input the trigger worker
    //     sends, so the Durable Object queues the prepared initial turn. The
    //     worker's balance gate refuses a payer under the $1 minimum, and a
    //     fixture account starts at $0, so say what to run instead of echoing
    //     the 402 body alone.
    const initiated = await initiatePreparedSession(
      ports.backendUrl,
      token,
      prepared.cloudAgentSessionId
    );
    admittedMessageId = initiated.messageId;
    initiateDelivery = initiated.delivery ?? null;
    // 4b. Nothing is ingested. The assertion that matters is that the store is
    //     empty while the session admitted a turn.
    admittedTurn = await waitForAdmittedTurnOutcome(
      ports.backendUrl,
      token,
      prepared.cloudAgentSessionId
    );
    page = admittedTurn.page;
    admittedMessages = admittedTurn.admittedMessages;
    hydratedMessageCount = readMessageCount(page);
    storedPageCount = hydratedMessageCount;
  } else {
    page = await trpc(ports.backendUrl, 'cloudAgentNext.getSessionMessagesPage', token, {
      sessionId: prepared.cloudAgentSessionId,
    });
    hydratedMessageCount = readMessageCount(page);
    storedPageCount = hydratedMessageCount;
  }

  // 5. The reads the app makes.
  const runtime = RuntimeSessionSchema.parse(
    await trpc(ports.backendUrl, 'cliSessionsV2.getWithRuntimeState', token, {
      session_id: prepared.kiloSessionId,
    })
  );
  // The prepared session's own page is served by its Durable Object, whose
  // registration marks history hydrated before any row exists; report it so
  // the ingestion is not mistaken for a hydration the control plane performed.
  const cloudPage =
    prepared.cloudAgentSessionId === null
      ? null
      : await readCloudAgentPageCount(ports.backendUrl, token, prepared.cloudAgentSessionId);
  const deliveries = DeliveriesSchema.parse(
    await trpc(ports.backendUrl, 'webhookTriggers.listRequests', token, { triggerId })
  );

  // 6. `--admitted` asserts the state it claims to seed before reporting it: a
  //    stale ingest transcript or a session that never admitted its turn would
  //    make the mode lie about what the app is looking at.
  //
  //    Admission is read from the Durable Object's own state, not from
  //    `initiatedAt`: this server build never writes that field (the metadata
  //    lifecycle is created with `{version, timestamp}` only), so the session's
  //    `initialMessageId` and the admitted turn's own row are what prove the
  //    turn was admitted.
  let admissionEvidence = '';
  if (mode === 'admitted') {
    const ingested = await readIngestedMessageCount(
      sessionIngestUrl,
      prepared.kiloSessionId,
      token
    );
    if (ingested !== 0) {
      throw new Error(
        `--admitted must leave session-ingest empty for ${prepared.kiloSessionId}; found ${ingested}`
      );
    }
    ingestedMessageCount = ingested;
    hydratedMessageCount = ingested;
    if (storedPageCount !== 0) {
      throw new Error(
        `--admitted must leave the pages empty for ${prepared.kiloSessionId}; found ${storedPageCount}`
      );
    }
    const admittedRuntime = runtime.runtimeState;
    if (admittedRuntime === null) {
      throw new Error(`--admitted needs a runtime for ${prepared.kiloSessionId}`);
    }
    const admittedId = admittedRuntime.initialMessageId;
    if (admittedId === undefined || admittedId === null) {
      throw new Error(
        `--admitted found no admitted turn on ${prepared.cloudAgentSessionId}: initialMessageId is null`
      );
    }
    if (admittedId !== admittedMessageId) {
      throw new Error(
        `--admitted's ack (${String(admittedMessageId)}) is not the session's initial turn (${admittedId})`
      );
    }
    const turnRow = (admittedTurn?.snapshot.queuedMessageCount ?? 0) > 0;
    if (!turnRow) {
      throw new Error(
        `--admitted's turn ${admittedId} is missing from the first page's snapshot rows`
      );
    }
    admissionEvidence = `initialMessageId=${admittedId};turnRow=present`;
  }

  const snapshot = admittedTurn?.snapshot ?? null;
  const admittedRuntime = runtime.runtimeState;

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
    initialMessageId: admittedRuntime?.initialMessageId ?? null,
    admittedMessageId,
    initiateDelivery,
    initiatedAt: admittedRuntime?.initiatedAt ?? null,
    preparedAt: admittedRuntime?.preparedAt ?? null,
    admittedMessages,
    admissionEvidence,
    admittedTurnSettled: admittedTurn === null ? null : admittedTurn.settled,
    admittedQueuedMessageCount: snapshot === null ? null : snapshot.queuedMessageCount,
    admittedQueuedDelivery: snapshot === null ? null : snapshot.queuedDelivery,
    admittedTerminalFailureCount: snapshot === null ? null : snapshot.terminalFailureCount,
    admissionPreparationAttemptCount: snapshot === null ? null : snapshot.preparationAttemptCount,
    admissionFailedPreparationCount: snapshot === null ? null : snapshot.failedPreparationCount,
    admissionPreparationStatus: snapshot === null ? null : snapshot.preparationStatus,
    admissionPreparationError: snapshot === null ? null : snapshot.preparationError,
    messageCount: storedPageCount,
    hydratedMessageCount,
    ingestedMessageCount,
    runtimeState: JSON.stringify(admittedRuntime),
    cloudAgentPageMessageCount: cloudPage === null ? null : cloudPage.count,
    cloudAgentPage: cloudPage === null ? null : JSON.stringify(cloudPage.page),
    messagesPage: JSON.stringify(page),
    sessionIngestPort: ports.sessionIngestPort,
    backendUrl: ports.backendUrl,
    deliveredRows: JSON.stringify(deliveries),
  };
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }
  const result = await main(args);
  console.log('');
  if (result.mode === 'admitted') {
    console.log('This fixture represents: a session whose initial turn the control plane');
    console.log('admitted, with an empty stored transcript and an empty session-ingest store.');
    console.log(
      'Suggested next step: read the session in the mobile app and record which card it shows.'
    );
  }
  return result;
}
