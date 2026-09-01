// Fixture builders, status parsing, and opt-in materialization polling.
// Importing this module has no database or network side effects.
import {
  DEFAULT_KILO_SDK_MESSAGE_PAGE_SIZE,
  kiloSdkMessageHistorySchema,
} from '@kilocode/session-ingest-contracts';

import type { SeedResult } from '../index';

export const ROOT_SESSION_ID = 'ses_000000000001RootFixture001';
export const CHILD_SESSION_ID = 'ses_000000000002ChildFixture01';
export const UNSUPPORTED_SESSION_ID = 'ses_000000000003Unsupported001';
export const EMPTY_SESSION_ID = 'ses_000000000004EmptyFixture01';

export const ROOT_SESSION_TITLE = 'Mobile sheet fixtures';
export const CHILD_SESSION_TITLE = 'Inspect child fixture';
export const UNSUPPORTED_SESSION_TITLE = 'Unsupported repository fixture';
export const EMPTY_SESSION_TITLE = 'Empty session fixture';
export const ROOT_SESSION_SLUG = 'mobile-sheet-fixtures';
export const CHILD_SESSION_SLUG = 'inspect-child-fixture';
export const UNSUPPORTED_SESSION_SLUG = 'unsupported-repository-fixture';
export const EMPTY_SESSION_SLUG = 'empty-session-fixture';

export const FIXTURE_PROJECT_ID = 'fixture';
export const FIXTURE_DIRECTORY = '/workspace';
export const FIXTURE_SESSION_VERSION = '1';

export const MODEL_PROVIDER_ID = 'kilo';
export const MODEL_ID = 'anthropic/claude-sonnet-4';
export const FIXTURE_AGENT = 'build';
export const FIXTURE_MODE = 'code';

export const ROOT_USER_MESSAGE_ID = 'msgRootUser00000001';
export const ROOT_ASSISTANT_MESSAGE_ID = 'msgRootAssistant001';
export const ROOT_READ_PART_ID = 'prtRootRead00000001';
export const ROOT_TASK_PART_ID = 'prtRootTask00000001';
export const ROOT_FILE_PART_ID = 'prtRootFile00000001';

export const CHILD_USER_MESSAGE_ID = 'msgChildUser0000001';
export const CHILD_ASSISTANT_MESSAGE_ID = 'msgChildAssistant01';
export const CHILD_BASH_PART_ID = 'prtChildBash0000001';

export const UNSUPPORTED_USER_MESSAGE_ID = 'msgUnsupported00001';

export const FIXTURE_TIME_CREATED = 1_700_000_000_000;
export const FIXTURE_TIME_UPDATED = 1_700_000_300_000;

const ROOT_USER_CREATED = 1_700_000_010_000;
const ROOT_ASSISTANT_CREATED = 1_700_000_020_000;
const ROOT_ASSISTANT_COMPLETED = 1_700_000_025_000;
const ROOT_READ_START = 1_700_000_021_000;
const ROOT_READ_END = 1_700_000_022_000;
const ROOT_TASK_START = 1_700_000_022_500;
const ROOT_TASK_END = 1_700_000_024_000;

const CHILD_USER_CREATED = 1_700_000_040_000;
const CHILD_ASSISTANT_CREATED = 1_700_000_050_000;
const CHILD_ASSISTANT_COMPLETED = 1_700_000_055_000;
const CHILD_BASH_START = 1_700_000_051_000;
const CHILD_BASH_END = 1_700_000_054_000;

const UNSUPPORTED_USER_CREATED = 1_700_000_060_000;

const ROOT_FILE_MIME = 'text/plain';
const ROOT_FILE_NAME = 'fixture-notes.txt';
const ROOT_FILE_URL = 'data:text/plain;base64,Zml4dHVyZSBub3RlcyBjb250ZW50';

export const SESSION_INGEST_SERVICE_NAME = 'cloudflare-session-ingest';

export type FixtureTokens = {
  total: number;
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
};

export type SessionIngestItem =
  | { type: 'session' | 'message' | 'part'; data: Record<string, unknown> }
  | { type: 'session_diff'; data: Array<Record<string, unknown>> };

export type SessionIngestServiceStatus = {
  name: string;
  status: 'up' | 'down';
  port: number;
};

const ROOT_ASSISTANT_COST = 0.01;
const ROOT_ASSISTANT_TOKENS: FixtureTokens = {
  total: 1375,
  input: 1000,
  output: 200,
  reasoning: 100,
  cache: { read: 50, write: 25 },
};

const CHILD_ASSISTANT_COST = 0.02;
const CHILD_ASSISTANT_TOKENS: FixtureTokens = {
  total: 500,
  input: 400,
  output: 60,
  reasoning: 30,
  cache: { read: 5, write: 5 },
};

/** The exact session IDs this seed resets. Nothing else is touched. */
export function fixtureSessionIds(childPerformance = false): string[] {
  return [
    ROOT_SESSION_ID,
    CHILD_SESSION_ID,
    UNSUPPORTED_SESSION_ID,
    EMPTY_SESSION_ID,
    ...(childPerformance ? PERFORMANCE_SESSION_IDS : []),
  ];
}

/** Part IDs that must appear in the materialized history for a fixture session. */
export function expectedPartIdsFor(sessionId: string): string[] {
  if (sessionId === ROOT_SESSION_ID) {
    return [ROOT_READ_PART_ID, ROOT_TASK_PART_ID, ROOT_FILE_PART_ID];
  }
  if (sessionId === CHILD_SESSION_ID) {
    return [CHILD_BASH_PART_ID];
  }
  if (sessionId === UNSUPPORTED_SESSION_ID || sessionId === EMPTY_SESSION_ID) {
    return [];
  }
  throw new Error(`Unknown fixture session id: ${sessionId}`);
}

export function buildSessionItem(params: {
  sessionId: string;
  slug: string;
  title: string;
  parentId?: string;
}): SessionIngestItem {
  return {
    type: 'session',
    data: {
      id: params.sessionId,
      slug: params.slug,
      projectID: FIXTURE_PROJECT_ID,
      directory: FIXTURE_DIRECTORY,
      ...(params.parentId === undefined ? {} : { parentID: params.parentId }),
      title: params.title,
      version: FIXTURE_SESSION_VERSION,
      time: { created: FIXTURE_TIME_CREATED, updated: FIXTURE_TIME_UPDATED },
    },
  };
}

export function buildUserMessageItem(params: {
  messageId: string;
  sessionId: string;
  createdAt: number;
}): SessionIngestItem {
  return {
    type: 'message',
    data: {
      id: params.messageId,
      sessionID: params.sessionId,
      role: 'user',
      time: { created: params.createdAt },
      agent: FIXTURE_AGENT,
      model: { providerID: MODEL_PROVIDER_ID, modelID: MODEL_ID },
    },
  };
}

export function buildAssistantMessageItem(params: {
  messageId: string;
  sessionId: string;
  parentId: string;
  createdAt: number;
  completedAt: number;
  cost: number;
  tokens: FixtureTokens;
}): SessionIngestItem {
  return {
    type: 'message',
    data: {
      id: params.messageId,
      sessionID: params.sessionId,
      role: 'assistant',
      time: { created: params.createdAt, completed: params.completedAt },
      parentID: params.parentId,
      modelID: MODEL_ID,
      providerID: MODEL_PROVIDER_ID,
      mode: FIXTURE_MODE,
      agent: FIXTURE_AGENT,
      path: { cwd: FIXTURE_DIRECTORY, root: FIXTURE_DIRECTORY },
      cost: params.cost,
      tokens: params.tokens,
    },
  };
}

export function buildToolPartItem(params: {
  partId: string;
  sessionId: string;
  messageId: string;
  callId: string;
  tool: string;
  status?: 'completed' | 'running' | 'error';
  input: Record<string, unknown>;
  output: string;
  title: string;
  metadata: Record<string, unknown>;
  start: number;
  end: number;
}): SessionIngestItem {
  return {
    type: 'part',
    data: {
      id: params.partId,
      sessionID: params.sessionId,
      messageID: params.messageId,
      type: 'tool',
      callID: params.callId,
      tool: params.tool,
      state:
        params.status === 'running'
          ? {
              status: 'running',
              input: params.input,
              title: params.title,
              metadata: params.metadata,
              time: { start: params.start },
            }
          : params.status === 'error'
            ? {
                status: 'error',
                input: params.input,
                error: params.output,
                metadata: params.metadata,
                time: { start: params.start, end: params.end },
              }
            : {
                status: 'completed',
                input: params.input,
                output: params.output,
                title: params.title,
                metadata: params.metadata,
                time: { start: params.start, end: params.end },
              },
    },
  };
}

export function buildFilePartItem(params: {
  partId: string;
  sessionId: string;
  messageId: string;
  mime: string;
  filename: string;
  url: string;
}): SessionIngestItem {
  return {
    type: 'part',
    data: {
      id: params.partId,
      sessionID: params.sessionId,
      messageID: params.messageId,
      type: 'file',
      mime: params.mime,
      filename: params.filename,
      url: params.url,
    },
  };
}

export function buildRootIngestItems(): SessionIngestItem[] {
  return [
    buildSessionItem({
      sessionId: ROOT_SESSION_ID,
      slug: ROOT_SESSION_SLUG,
      title: ROOT_SESSION_TITLE,
    }),
    buildUserMessageItem({
      messageId: ROOT_USER_MESSAGE_ID,
      sessionId: ROOT_SESSION_ID,
      createdAt: ROOT_USER_CREATED,
    }),
    buildAssistantMessageItem({
      messageId: ROOT_ASSISTANT_MESSAGE_ID,
      sessionId: ROOT_SESSION_ID,
      parentId: ROOT_USER_MESSAGE_ID,
      createdAt: ROOT_ASSISTANT_CREATED,
      completedAt: ROOT_ASSISTANT_COMPLETED,
      cost: ROOT_ASSISTANT_COST,
      tokens: ROOT_ASSISTANT_TOKENS,
    }),
    buildToolPartItem({
      partId: ROOT_READ_PART_ID,
      sessionId: ROOT_SESSION_ID,
      messageId: ROOT_ASSISTANT_MESSAGE_ID,
      callId: 'callRootRead000001',
      tool: 'read',
      input: { filePath: '/workspace/direct-fixture.txt' },
      output: 'direct fixture output',
      title: 'Read direct-fixture.txt',
      metadata: {},
      start: ROOT_READ_START,
      end: ROOT_READ_END,
    }),
    buildToolPartItem({
      partId: ROOT_TASK_PART_ID,
      sessionId: ROOT_SESSION_ID,
      messageId: ROOT_ASSISTANT_MESSAGE_ID,
      callId: 'callRootTask000001',
      tool: 'task',
      input: { subagent_type: 'Explorer', description: CHILD_SESSION_TITLE },
      output: 'child fixture inspected',
      title: CHILD_SESSION_TITLE,
      metadata: { sessionId: CHILD_SESSION_ID },
      start: ROOT_TASK_START,
      end: ROOT_TASK_END,
    }),
    buildFilePartItem({
      partId: ROOT_FILE_PART_ID,
      sessionId: ROOT_SESSION_ID,
      messageId: ROOT_ASSISTANT_MESSAGE_ID,
      mime: ROOT_FILE_MIME,
      filename: ROOT_FILE_NAME,
      url: ROOT_FILE_URL,
    }),
    {
      type: 'session_diff',
      data: [{ file: 'direct-fixture.txt', additions: 1, deletions: 0 }],
    },
  ];
}

export function buildChildIngestItems(): SessionIngestItem[] {
  return [
    buildSessionItem({
      sessionId: CHILD_SESSION_ID,
      slug: CHILD_SESSION_SLUG,
      title: CHILD_SESSION_TITLE,
      parentId: ROOT_SESSION_ID,
    }),
    buildUserMessageItem({
      messageId: CHILD_USER_MESSAGE_ID,
      sessionId: CHILD_SESSION_ID,
      createdAt: CHILD_USER_CREATED,
    }),
    buildAssistantMessageItem({
      messageId: CHILD_ASSISTANT_MESSAGE_ID,
      sessionId: CHILD_SESSION_ID,
      parentId: CHILD_USER_MESSAGE_ID,
      createdAt: CHILD_ASSISTANT_CREATED,
      completedAt: CHILD_ASSISTANT_COMPLETED,
      cost: CHILD_ASSISTANT_COST,
      tokens: CHILD_ASSISTANT_TOKENS,
    }),
    buildToolPartItem({
      partId: CHILD_BASH_PART_ID,
      sessionId: CHILD_SESSION_ID,
      messageId: CHILD_ASSISTANT_MESSAGE_ID,
      callId: 'callChildBash00001',
      tool: 'bash',
      input: { command: 'printf child-fixture' },
      output: 'child fixture output',
      title: 'Run child fixture command',
      metadata: {},
      start: CHILD_BASH_START,
      end: CHILD_BASH_END,
    }),
  ];
}

export function buildUnsupportedIngestItems(): SessionIngestItem[] {
  return [
    buildSessionItem({
      sessionId: UNSUPPORTED_SESSION_ID,
      slug: UNSUPPORTED_SESSION_SLUG,
      title: UNSUPPORTED_SESSION_TITLE,
    }),
    buildUserMessageItem({
      messageId: UNSUPPORTED_USER_MESSAGE_ID,
      sessionId: UNSUPPORTED_SESSION_ID,
      createdAt: UNSUPPORTED_USER_CREATED,
    }),
  ];
}

export function buildEmptyIngestItems(): SessionIngestItem[] {
  return [
    buildSessionItem({
      sessionId: EMPTY_SESSION_ID,
      slug: EMPTY_SESSION_SLUG,
      title: EMPTY_SESSION_TITLE,
    }),
  ];
}

export const PERFORMANCE_ROOT_SESSION_ID = 'ses_000000000006ChildPerfRoot1';
export const SELECTED_CHILD_SESSION_ID = 'ses_000000000007ChildPerf00001';
export const EMPTY_CHILD_SESSION_ID = 'ses_000000000007ChildPerf00024';
export const NESTED_CHILD_SESSION_ID = 'ses_000000000008ChildPerfNest1';

const PERFORMANCE_CHILD_IDS = Array.from(
  { length: 24 },
  (_, index) => `ses_000000000007ChildPerf${String(index + 1).padStart(5, '0')}`
);
const PERFORMANCE_SESSION_IDS = [
  PERFORMANCE_ROOT_SESSION_ID,
  ...PERFORMANCE_CHILD_IDS,
  NESTED_CHILD_SESSION_ID,
];

export type ChildPerformanceFixture = {
  sessionId: string;
  parentId?: string;
  title: string;
  messageCount: number;
  items: SessionIngestItem[];
};

/** Children precede their parents; the default reset order stays unchanged. */
export function fixtureCleanupSessionIds(childPerformance = false): string[] {
  return [
    ...(childPerformance ? [...PERFORMANCE_SESSION_IDS].reverse() : []),
    CHILD_SESSION_ID,
    ROOT_SESSION_ID,
    UNSUPPORTED_SESSION_ID,
    EMPTY_SESSION_ID,
  ];
}

export function buildMobileSheetFixtureResult(
  context: {
    userId: string;
    email: string;
    usedRepository: string;
    sessionIngestPort: number;
    sessionIngestUrl: string;
  },
  childPerformance = false
): SeedResult {
  return {
    userId: context.userId,
    email: context.email,
    rootSessionId: ROOT_SESSION_ID,
    childSessionId: CHILD_SESSION_ID,
    unsupportedSessionId: UNSUPPORTED_SESSION_ID,
    emptySessionId: EMPTY_SESSION_ID,
    usedRepository: context.usedRepository,
    sessionIngestPort: context.sessionIngestPort,
    sessionIngestUrl: context.sessionIngestUrl,
    ...(childPerformance
      ? {
          performanceRootSessionId: PERFORMANCE_ROOT_SESSION_ID,
          performanceChildSessionIds: PERFORMANCE_CHILD_IDS.join(','),
          selectedChildSessionId: SELECTED_CHILD_SESSION_ID,
          nestedChildSessionId: NESTED_CHILD_SESSION_ID,
          emptyChildSessionId: EMPTY_CHILD_SESSION_ID,
          performanceChildCount: PERFORMANCE_CHILD_IDS.length,
          ordinaryChildMessageCount: 12,
          pagedChildMessageCount: 120,
        }
      : {}),
  };
}

/** A separate tree keeps default fixtures unchanged, even after an opt-in run. */
export function buildChildPerformanceFixtures(): ChildPerformanceFixture[] {
  const sessions = [
    {
      sessionId: PERFORMANCE_ROOT_SESSION_ID,
      parentId: undefined,
      title: 'Child performance fixtures',
      messageCount: 2,
    },
    ...PERFORMANCE_CHILD_IDS.map((sessionId, index) => ({
      sessionId,
      parentId: PERFORMANCE_ROOT_SESSION_ID,
      title:
        sessionId === EMPTY_CHILD_SESSION_ID
          ? 'Empty child performance fixture'
          : `Inspect performance child ${String(index + 1).padStart(2, '0')}`,
      messageCount:
        sessionId === EMPTY_CHILD_SESSION_ID
          ? 0
          : sessionId === SELECTED_CHILD_SESSION_ID
            ? 120
            : 12,
    })),
    {
      sessionId: NESTED_CHILD_SESSION_ID,
      parentId: SELECTED_CHILD_SESSION_ID,
      title: 'Inspect nested performance child',
      messageCount: 120,
    },
  ];

  return sessions.map((session, sessionIndex) => {
    const messageIdFor = (index: number) =>
      `msg${session.sessionId.slice(4)}${String(index).padStart(4, '0')}`;
    const messages: SessionIngestItem[] = [];
    const parts: SessionIngestItem[] = [];
    for (let index = 1; index <= session.messageCount; index += 1) {
      const createdAt = FIXTURE_TIME_CREATED + index * 1_000;
      const messageId = messageIdFor(index);
      messages.push(
        index % 2 === 1
          ? buildUserMessageItem({ messageId, sessionId: session.sessionId, createdAt })
          : buildAssistantMessageItem({
              messageId,
              sessionId: session.sessionId,
              parentId: messageIdFor(index - 1),
              createdAt,
              completedAt: createdAt + 200,
              cost: CHILD_ASSISTANT_COST,
              tokens: CHILD_ASSISTANT_TOKENS,
            })
      );
      parts.push({
        type: 'part',
        data: {
          id: `prt${session.sessionId.slice(4)}${String(index).padStart(4, '0')}`,
          sessionID: session.sessionId,
          messageID: messageId,
          type: 'text',
          text: [
            session.title,
            '',
            `Synthetic ${index % 2 === 1 ? 'user' : 'assistant'} message ${index} of ${session.messageCount}.`,
            'This deterministic transcript contains no repository or user data.',
            `Read-only fixture marker A: ${index}.`,
            `Read-only fixture marker B: ${index}.`,
            `Read-only fixture marker C: ${index}.`,
          ].join('\n'),
        },
      });
    }

    const children = sessions.filter(child => child.parentId === session.sessionId);
    for (const [index, child] of children.entries()) {
      const status =
        child.sessionId === EMPTY_CHILD_SESSION_ID || index % 3 === 0
          ? 'completed'
          : index % 3 === 1
            ? 'running'
            : 'error';
      parts.push(
        buildToolPartItem({
          partId: `prtTask${child.sessionId.slice(4)}`,
          sessionId: session.sessionId,
          messageId: messageIdFor(session.messageCount),
          callId: `callTask${child.sessionId.slice(4)}`,
          tool: 'task',
          status,
          input: {
            subagent_type: 'Explorer',
            description: child.title,
            prompt: `Inspect synthetic fixture ${child.sessionId}.`,
          },
          output: status === 'error' ? 'Synthetic task failure.' : 'Synthetic task completed.',
          title: child.title,
          metadata: { sessionId: child.sessionId },
          start: FIXTURE_TIME_CREATED + session.messageCount * 1_000,
          end: FIXTURE_TIME_CREATED + session.messageCount * 1_000 + 200,
        })
      );
    }

    return {
      ...session,
      items: [
        buildSessionItem({
          sessionId: session.sessionId,
          parentId: session.parentId,
          title: session.title,
          slug: `child-performance-${sessionIndex}`,
        }),
        ...messages,
        ...parts,
      ],
    };
  });
}

/** Walk each real cursor; a successful empty page is distinct from pending history. */
export async function pollForChildPerformanceFixture(
  baseUrl: string,
  token: string,
  fixture: ChildPerformanceFixture
): Promise<void> {
  const expectedMessages = fixture.items.flatMap(item =>
    item.type === 'message' && typeof item.data.id === 'string' ? [item.data.id] : []
  );
  const expectedParts = fixture.items.flatMap(item =>
    item.type === 'part' && typeof item.data.id === 'string' ? [item.data.id] : []
  );
  const deadline = Date.now() + 30_000;

  for (;;) {
    const seenMessages = new Set<string>();
    const seenParts = new Set<string>();
    const cursors = new Set<string>();
    let before: string | undefined;
    let hasHistory = true;
    let hasOlder = false;
    do {
      const query = new URLSearchParams({ limit: String(DEFAULT_KILO_SDK_MESSAGE_PAGE_SIZE) });
      if (before !== undefined) query.set('before', before);
      const response = await fetch(
        `${baseUrl}/api/session/${fixture.sessionId}/messages?${query}`,
        {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        }
      );
      if (!response.ok) {
        throw new Error(`Messages read of ${fixture.sessionId} failed (${response.status})`);
      }
      if (response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
        throw new Error(`Messages read of ${fixture.sessionId} did not return application/json`);
      }
      const payload: unknown = await response.json();
      if (
        !isRecord(payload) ||
        payload.success !== true ||
        payload.kiloSessionId !== fixture.sessionId
      ) {
        throw new Error(`Messages read of ${fixture.sessionId} returned an unexpected shape`);
      }
      if (payload.history === null) {
        hasHistory = false;
        break;
      }
      const parsed = kiloSdkMessageHistorySchema.safeParse(payload.history);
      if (!parsed.success) {
        throw new Error(
          `Messages read of ${fixture.sessionId} returned an unexpected history shape`
        );
      }
      const page = parsed.data;
      if ('kind' in page) {
        if (page.kind === 'retryable_failure') {
          hasHistory = false;
          break;
        }
        throw new Error(`session-ingest reported ${page.kind} for ${fixture.sessionId}`);
      }
      if (page.omittedItemCount !== 0) {
        throw new Error(`session-ingest omitted fixture items for ${fixture.sessionId}`);
      }
      if (before === undefined) hasOlder = page.nextCursor !== null;
      for (const message of page.messages) {
        if (message.info.sessionID !== fixture.sessionId || seenMessages.has(message.info.id)) {
          throw new Error(`Unexpected or duplicate message in ${fixture.sessionId}`);
        }
        seenMessages.add(message.info.id);
        for (const part of message.parts) {
          if (part.sessionID !== fixture.sessionId || part.messageID !== message.info.id) {
            throw new Error(`Unexpected part relationship in ${fixture.sessionId}`);
          }
          seenParts.add(part.id);
        }
      }
      before = page.nextCursor ?? undefined;
      if (before !== undefined) {
        if (!before || cursors.has(before)) {
          throw new Error(`Invalid or repeated history cursor for ${fixture.sessionId}`);
        }
        cursors.add(before);
      }
    } while (before !== undefined);

    if (
      hasHistory &&
      (expectedMessages.length <= DEFAULT_KILO_SDK_MESSAGE_PAGE_SIZE || hasOlder) &&
      seenMessages.size === expectedMessages.length &&
      expectedMessages.every(id => seenMessages.has(id)) &&
      seenParts.size === expectedParts.length &&
      expectedParts.every(id => seenParts.has(id))
    ) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for complete child performance history of ${fixture.sessionId}`
      );
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses the `pnpm -s dev:status --json` output and returns the
 * `cloudflare-session-ingest` service entry. Throws when the service is
 * missing or its status/port fields are malformed.
 */
export function parseSessionIngestServiceStatus(json: string): SessionIngestServiceStatus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('dev:status --json did not return valid JSON');
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.services)) {
    throw new Error('dev:status --json returned no services array');
  }

  const entry = parsed.services.find(
    (service): service is Record<string, unknown> =>
      isRecord(service) && service.name === SESSION_INGEST_SERVICE_NAME
  );
  if (!entry) {
    throw new Error(`dev:status --json did not report the ${SESSION_INGEST_SERVICE_NAME} service`);
  }

  if (entry.status !== 'up' && entry.status !== 'down') {
    throw new Error(
      `dev:status --json reported an invalid status for ${SESSION_INGEST_SERVICE_NAME}`
    );
  }
  if (typeof entry.port !== 'number' || !Number.isInteger(entry.port) || entry.port <= 0) {
    throw new Error(
      `dev:status --json reported an invalid port for ${SESSION_INGEST_SERVICE_NAME}`
    );
  }

  return {
    name: SESSION_INGEST_SERVICE_NAME,
    status: entry.status,
    port: entry.port,
  };
}
