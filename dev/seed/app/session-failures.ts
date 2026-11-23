import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  cli_sessions_v2,
  cloud_agent_session_runs,
  cloud_agent_sessions,
  kilocode_users,
} from '@kilocode/db/schema';
import { signKiloToken } from '@kilocode/worker-utils';
import { and, eq, inArray, or } from 'drizzle-orm';

import type { SeedResult } from '../index';
import { assertLocalSeedDatabase, getSeedDb } from '../lib/db';
import { normalizeSeedEmail } from '../lib/email';
import {
  buildAssistantMessageItem,
  buildSessionItem,
  buildUserMessageItem,
  type SessionIngestItem,
  type SessionIngestServiceStatus,
  parseSessionIngestServiceStatus,
} from '../lib/mobile-sheet-fixtures';
import { seedTokenSigningParams } from '../lib/token-signing';

export const usage = '<email> [--no-transcript]';

const TOKEN_EXPIRES_SECONDS = 3600;
const POLL_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;

/**
 * The session the failure-history surface reads. It carries the `agent_` prefix
 * the web component gates on (`/^(agent|workspace)_/`), so the app treats it as
 * a Cloud Agent session with failure history instead of skipping the read.
 */
export const FAILURE_SESSION_ID = 'ses_failuresHistoryFixture0001';
export const FAILURE_SESSION_TITLE = 'Failure history fixture';
export const FAILURE_CLOUD_AGENT_SESSION_ID = 'agent_failures_history_fixture';
const FAILURE_SLUG = 'failure-history-fixture';

/**
 * The control session: a Cloud Agent session that never failed. The app must
 * render no failure section at all for it, the same early return the web view
 * makes, so it is the fixture for the empty state.
 */
export const NO_FAILURE_SESSION_ID = 'ses_failuresNoneFixture0000001';
export const NO_FAILURE_SESSION_TITLE = 'No failures fixture';
export const NO_FAILURE_CLOUD_AGENT_SESSION_ID = 'agent_no_failures_fixture';
const NO_FAILURE_SLUG = 'no-failures-fixture';

/** A diagnostic that is still retained: the row shows it under the failure. */
const PRESENT_DIAGNOSTIC = 'Initial admission was rejected: sandbox queue unavailable';
/** The run's own retained diagnostic, distinct from the setup one above. */
const RUN_DIAGNOSTIC = 'Agent wrapper stopped responding after 30s';
/** A diagnostic past its retention date: the row shows no text, the export marks it expired. */
const EXPIRED_DIAGNOSTIC = 'Expired diagnostic from an earlier attempt';

const MSG_SETUP = 'msgFailureSetup00000000001';
const MSG_FAILED = 'msgFailureFailed00000000001';
const MSG_COMPLETED = 'msgFailureCompleted000000001';
const MSG_EXPIRED = 'msgFailureExpired0000000001';
const MSG_USER = 'msgFailureUser00000000001';
const MSG_ASSISTANT = 'msgFailureAssistant0000001';
const MSG_NO_FAILURE_USER = 'msgNoFailureUser0000000001';
const MSG_NO_FAILURE_ASSISTANT = 'msgNoFailureAssistant00001';

function isoAt(daysAgo: number, minutes = 0): string {
  return new Date(Date.now() - daysAgo * 86_400_000 - minutes * 60_000).toISOString();
}

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed app:session-failures ${usage}`);
  console.log('');
  console.log('Seeds one Cloud Agent session whose failure history has every row the');
  console.log('mobile session view renders: an environment setup failure, a failed run');
  console.log('with a retained diagnostic, a completed run, and a failed run whose');
  console.log('diagnostic retention has expired. The transcript is a short exchange so');
  console.log('the session opens as a normal chat.');
  console.log('');
  console.log('The session id is ' + FAILURE_SESSION_ID + ' and its Cloud Agent id is');
  console.log(FAILURE_CLOUD_AGENT_SESSION_ID + '. Open kiloapp:///(app)/agent-chat/' + FAILURE_SESSION_ID);
  console.log('and the failure-history section reports two failed runs and one completed.');
  console.log('');
  console.log('--no-transcript seeds only the rows, without the session-ingest round trip.');
  console.log('');
  console.log('Example:');
  console.log('  pnpm dev:seed app:session-failures ada@example.com');
}

async function ingestSession(
  baseUrl: string,
  sessionId: string,
  token: string,
  items: SessionIngestItem[]
): Promise<void> {
  const response = await fetch(`${baseUrl}/api/session/${sessionId}/ingest?v=1`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: items }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ingest of ${sessionId} failed (${response.status}): ${body}`);
  }
}

/** Waits for the transcript page the app reads to report the exchange. */
async function pollForTranscript(baseUrl: string, sessionId: string, token: string): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const response = await fetch(`${baseUrl}/api/session/${sessionId}/messages?limit=50`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(`Messages read of ${sessionId} failed (${response.status})`);
    }
    const payload: unknown = await response.json();
    const history =
      payload !== null && typeof payload === 'object' && 'history' in payload
        ? payload.history
        : undefined;
    if (history !== null && typeof history === 'object' && 'messages' in history) {
      const messages = history.messages;
      if (Array.isArray(messages) && messages.length > 0) {
        return;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for the transcript of ${sessionId}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/** One short exchange, so a fixture session opens as an ordinary chat. */
function transcriptItems({
  sessionId,
  slug,
  title,
  userMessageId,
  assistantMessageId,
  partId,
  prompt,
}: {
  sessionId: string;
  slug: string;
  title: string;
  userMessageId: string;
  assistantMessageId: string;
  partId: string;
  prompt: string;
}): SessionIngestItem[] {
  const createdAt = Date.now() - 3 * 3_600_000;
  return [
    buildSessionItem({ sessionId, slug, title }),
    buildUserMessageItem({ messageId: userMessageId, sessionId, createdAt }),
    buildAssistantMessageItem({
      messageId: assistantMessageId,
      sessionId,
      parentId: userMessageId,
      createdAt: createdAt + 500,
      completedAt: createdAt + 4_000,
      cost: 0.01,
      tokens: {
        total: 1_200,
        input: 1_000,
        output: 200,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    }),
    {
      type: 'part',
      data: {
        id: partId,
        sessionID: sessionId,
        messageID: userMessageId,
        type: 'text',
        text: prompt,
      },
    },
  ];
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }
  const email = args.find(argument => !argument.startsWith('--'))?.trim();
  if (!email) {
    printUsage();
    throw new Error('email is required');
  }
  const withTranscript = !args.includes('--no-transcript');

  assertLocalSeedDatabase('app:session-failures');
  const db = getSeedDb();
  const normalizedEmail = normalizeSeedEmail(email);
  const matches = await db
    .select({
      userId: kilocode_users.id,
      email: kilocode_users.google_user_email,
      apiTokenPepper: kilocode_users.api_token_pepper,
      isAdmin: kilocode_users.is_admin,
    })
    .from(kilocode_users)
    .where(
      or(
        eq(kilocode_users.google_user_email, email),
        eq(kilocode_users.normalized_email, normalizedEmail)
      )
    );

  if (matches.length === 0) {
    throw new Error(
      `No user found for email ${email}. Sign in locally first, or seed a user (pnpm dev:seed app:create-user).`
    );
  }
  const exactMatches = matches.filter(match => match.email === email);
  const resolvedMatches = exactMatches.length > 0 ? exactMatches : matches;
  if (resolvedMatches.length > 1) {
    throw new Error(
      `Multiple users matched ${email}: ${resolvedMatches.map(match => match.email).join(', ')}`
    );
  }
  const [user] = resolvedMatches;

  // Reset only this fixture, children before parents. The stored session is
  // found by its Cloud Agent id as well as by its session id: an interrupted
  // earlier run leaves the row behind under the id it was created with.
  await db
    .delete(cloud_agent_session_runs)
    .where(eq(cloud_agent_session_runs.cloud_agent_session_id, FAILURE_CLOUD_AGENT_SESSION_ID));
  await db
    .delete(cloud_agent_sessions)
    .where(eq(cloud_agent_sessions.cloud_agent_session_id, FAILURE_CLOUD_AGENT_SESSION_ID));
  await db
    .delete(cloud_agent_sessions)
    .where(eq(cloud_agent_sessions.cloud_agent_session_id, NO_FAILURE_CLOUD_AGENT_SESSION_ID));
  await db
    .delete(cli_sessions_v2)
    .where(
      and(
        eq(cli_sessions_v2.kilo_user_id, user.userId),
        or(
          eq(cli_sessions_v2.cloud_agent_session_id, FAILURE_CLOUD_AGENT_SESSION_ID),
          eq(cli_sessions_v2.cloud_agent_session_id, NO_FAILURE_CLOUD_AGENT_SESSION_ID),
          inArray(cli_sessions_v2.session_id, [FAILURE_SESSION_ID, NO_FAILURE_SESSION_ID])
        )
      )
    );

  const createdAt = isoAt(3);

  await db.insert(cli_sessions_v2).values([
    {
      session_id: FAILURE_SESSION_ID,
      kilo_user_id: user.userId,
      title: FAILURE_SESSION_TITLE,
      created_on_platform: 'cloud-agent-web',
      cloud_agent_session_id: FAILURE_CLOUD_AGENT_SESSION_ID,
      cloud_agent_session_scope_id: FAILURE_CLOUD_AGENT_SESSION_ID,
      created_at: createdAt,
    },
    {
      session_id: NO_FAILURE_SESSION_ID,
      kilo_user_id: user.userId,
      title: NO_FAILURE_SESSION_TITLE,
      created_on_platform: 'cloud-agent-web',
      cloud_agent_session_id: NO_FAILURE_CLOUD_AGENT_SESSION_ID,
      cloud_agent_session_scope_id: NO_FAILURE_CLOUD_AGENT_SESSION_ID,
      created_at: createdAt,
    },
  ] satisfies Array<typeof cli_sessions_v2.$inferInsert>);

  await db.insert(cloud_agent_sessions).values([
    {
      cloud_agent_session_id: FAILURE_CLOUD_AGENT_SESSION_ID,
      kilo_session_id: FAILURE_SESSION_ID,
      initial_message_id: MSG_SETUP,
      created_at: createdAt,
      // A classified setup failure: the pair the schema's check constraint allows.
      failure_at: isoAt(3, 6),
      failure_stage: 'initial_admission',
      failure_code: 'initial_admission_rejected',
      failure_responsibility: 'platform',
      failure_reason: 'wrapper_liveness',
      error_message_redacted: PRESENT_DIAGNOSTIC,
      error_expires_at: isoAt(-27),
    },
    {
      // No failure columns and no runs: the control session.
      cloud_agent_session_id: NO_FAILURE_CLOUD_AGENT_SESSION_ID,
      kilo_session_id: NO_FAILURE_SESSION_ID,
      initial_message_id: MSG_NO_FAILURE_USER,
      created_at: createdAt,
    },
  ] satisfies Array<typeof cloud_agent_sessions.$inferInsert>);

  await db.insert(cloud_agent_session_runs).values([
    {
      cloud_agent_session_id: FAILURE_CLOUD_AGENT_SESSION_ID,
      message_id: MSG_FAILED,
      status: 'failed',
      queued_at: isoAt(3, 30),
      dispatch_accepted_at: isoAt(3, 29),
      terminal_at: isoAt(3, 28),
      failure_stage: 'pre_dispatch',
      failure_code: 'wrapper_ping_timeout',
      failure_responsibility: 'platform',
      failure_reason: 'wrapper_liveness',
      error_message_redacted: RUN_DIAGNOSTIC,
      error_expires_at: isoAt(-27),
      wrapper_run_id: 'wrapper_failure_fixture',
    },
    {
      cloud_agent_session_id: FAILURE_CLOUD_AGENT_SESSION_ID,
      message_id: MSG_COMPLETED,
      status: 'completed',
      queued_at: isoAt(2, 5),
      terminal_at: isoAt(2, 1),
    },
    {
      // Retained row whose diagnostic has expired: the app shows the failure
      // text and no diagnostic, and the export marks the status expired.
      cloud_agent_session_id: FAILURE_CLOUD_AGENT_SESSION_ID,
      message_id: MSG_EXPIRED,
      status: 'failed',
      queued_at: isoAt(45, 20),
      terminal_at: isoAt(45, 18),
      failure_stage: 'post_dispatch_no_activity',
      failure_code: 'workspace_setup_failed',
      failure_responsibility: 'user',
      failure_reason: 'workspace_setup_failed',
      error_message_redacted: EXPIRED_DIAGNOSTIC,
      error_expires_at: isoAt(15),
    },
  ] satisfies Array<typeof cloud_agent_session_runs.$inferInsert>);

  let transcript = 'skipped';
  if (withTranscript) {
    const secret = process.env.NEXTAUTH_SECRET;
    if (!secret) {
      throw new Error('NEXTAUTH_SECRET is not set for this worktree.');
    }
    const { token } = await signKiloToken({
      userId: user.userId,
      pepper: user.apiTokenPepper,
      secret,
      ...seedTokenSigningParams(TOKEN_EXPIRES_SECONDS),
      extra: user.isAdmin ? { isAdmin: true } : undefined,
    });
    const serviceStatus: SessionIngestServiceStatus = parseSessionIngestServiceStatus(
      execFileSync('pnpm', ['-s', 'dev:status', '--json'], { encoding: 'utf8' })
    );
    if (serviceStatus.status !== 'up') {
      throw new Error(
        `cloudflare-session-ingest is not up (status=${serviceStatus.status}). Start the local stack first.`
      );
    }
    const sessionIngestUrl = `http://localhost:${serviceStatus.port}`;
    await ingestSession(
      sessionIngestUrl,
      FAILURE_SESSION_ID,
      token,
      transcriptItems({
        sessionId: FAILURE_SESSION_ID,
        slug: FAILURE_SLUG,
        title: FAILURE_SESSION_TITLE,
        userMessageId: MSG_USER,
        assistantMessageId: MSG_ASSISTANT,
        partId: 'prtFailureFixture00000001',
        prompt: 'Set up the workspace and run the test suite.',
      })
    );
    await pollForTranscript(sessionIngestUrl, FAILURE_SESSION_ID, token);
    await ingestSession(
      sessionIngestUrl,
      NO_FAILURE_SESSION_ID,
      token,
      transcriptItems({
        sessionId: NO_FAILURE_SESSION_ID,
        slug: NO_FAILURE_SLUG,
        title: NO_FAILURE_SESSION_TITLE,
        userMessageId: MSG_NO_FAILURE_USER,
        assistantMessageId: MSG_NO_FAILURE_ASSISTANT,
        partId: 'prtNoFailureFixture000001',
        prompt: 'Run the test suite.',
      })
    );
    await pollForTranscript(sessionIngestUrl, NO_FAILURE_SESSION_ID, token);
    transcript = 'ingested';
  }

  console.log('');
  console.log('This fixture represents a Cloud Agent session that failed twice and succeeded once.');
  console.log('The setup failure carries a retained diagnostic; the oldest failed run has an');
  console.log('expired one. Its control session, ' + NO_FAILURE_SESSION_ID + ', never failed,');
  console.log('so the app renders no failure section for it at all.');
  console.log('');
  console.log('Suggested next steps:');
  console.log('  kiloapp:///(app)/agent-chat/' + FAILURE_SESSION_ID + '   (setup failure, two failed runs)');
  console.log('  kiloapp:///(app)/agent-chat/' + NO_FAILURE_SESSION_ID + '   (no section)');
  console.log('The JSON export of the first lists one setup row and three run rows.');

  return {
    userId: user.userId,
    email,
    sessionId: FAILURE_SESSION_ID,
    cloudAgentSessionId: FAILURE_CLOUD_AGENT_SESSION_ID,
    noFailureSessionId: NO_FAILURE_SESSION_ID,
    noFailureCloudAgentSessionId: NO_FAILURE_CLOUD_AGENT_SESSION_ID,
    failedRuns: 2,
    completedRuns: 1,
    transcript,
  };
}
